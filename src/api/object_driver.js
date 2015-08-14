// module targets: nodejs & browserify
'use strict';

var util = require('util');
var Readable = require('stream').Readable;
var _ = require('lodash');
var Q = require('q');
var Semaphore = require('noobaa-util/semaphore');
var transformer = require('../util/transformer');
var Pipeline = require('../util/pipeline');
var CoalesceStream = require('../util/coalesce_stream');
var range_utils = require('../util/range_utils');
var size_utils = require('../util/size_utils');
var LRUCache = require('../util/lru_cache');
var devnull = require('dev-null');
var config = require('../../config.js');
var dbg = require('noobaa-util/debug_module')(__filename);
var bindings = require('bindings');
var native_util = typeof(bindings) === 'function' && bindings('native_util.node');

module.exports = ObjectDriver;

if (native_util) {
    // these threadpools are global OS threads used to offload heavy CPU work
    // from the node.js thread so that it will keep processing incoming IO while
    // encoding/decoding the object chunks in high performance native code.
    var dedup_chunker_tpool = new native_util.ThreadPool(1);
    var object_coding_tpool = new native_util.ThreadPool(1);
}


/**
 *
 * OBJECT DRIVER
 *
 * the object driver is a "heavy" object with data caches.
 *
 * extends object_api which is plain REST api with logic to provide access
 * to remote object storage, and does the necessary distributed of io.
 * the client functions usually have the signature function(params), and return a promise.
 *
 * this is the client side (web currently) that sends the commands
 * defined in object_api to the web server.
 *
 */
function ObjectDriver(client) {
    var self = this;

    self.client = client;

    // some constants that might be provided as options to the client one day

    self.OBJECT_RANGE_ALIGN_NBITS = 19; // log2( 512 KB )
    self.OBJECT_RANGE_ALIGN = 1 << self.OBJECT_RANGE_ALIGN_NBITS; // 512 KB

    self.MAP_RANGE_ALIGN_NBITS = 24; // log2( 16 MB )
    self.MAP_RANGE_ALIGN = 1 << self.MAP_RANGE_ALIGN_NBITS; // 16 MB

    self.READ_CONCURRENCY = config.READ_CONCURRENCY;
    self.WRITE_CONCURRENCY = config.WRITE_CONCURRENCY;

    self.READ_RANGE_CONCURRENCY = config.READ_RANGE_CONCURRENCY;

    self.HTTP_PART_ALIGN_NBITS = self.OBJECT_RANGE_ALIGN_NBITS + 6; // log2( 32 MB )
    self.HTTP_PART_ALIGN = 1 << self.HTTP_PART_ALIGN_NBITS; // 32 MB
    self.HTTP_TRUNCATE_PART_SIZE = false;

    self._block_write_sem = new Semaphore(self.WRITE_CONCURRENCY);
    self._block_read_sem = new Semaphore(self.READ_CONCURRENCY);
    self._finalize_sem = new Semaphore(config.REPLICATE_CONCURRENCY);

    self._init_object_md_cache();
    self._init_object_range_cache();
    self._init_object_map_cache();
    self._init_blocks_cache();
}





// WRITE FLOW /////////////////////////////////////////////////////////////////


/**
 *
 * UPLOAD_STREAM
 *
 */
ObjectDriver.prototype.upload_stream = function(params) {
    var self = this;
    var create_params = _.pick(params, 'bucket', 'key', 'size', 'content_type');
    var bucket_key_params = _.pick(params, 'bucket', 'key');

    dbg.log0('upload_stream: start upload', params.key);
    return self.client.object.create_multipart_upload(create_params)
        .then(function() {
            return self.upload_stream_parts(params);
        })
        .then(function() {
            dbg.log0('upload_stream: complete upload', params.key);
            return self.client.object.complete_multipart_upload(bucket_key_params);
        }, function(err) {
            dbg.log0('upload_stream: error write stream', params.key, err);
            throw err;
        });
};

/**
 *
 * UPLOAD_STREAM_PART
 *
 */
ObjectDriver.prototype.upload_stream_parts = function(params) {
    var self = this;
    var start = params.start || 0;
    var upload_part_number = params.upload_part_number || 0;
    var part_sequence_number = params.part_sequence_number || 0;

    dbg.log0('upload_stream: start', params.key, 'part number', upload_part_number,
        'sequence number', part_sequence_number);
    return Q.fcall(function() {
        var pipeline = new Pipeline(params.source_stream);

        //////////////////////////////
        // PIPELINE: dedup chunking //
        //////////////////////////////

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 10
            },
            init: function() {
                this.chunker = new native_util.DedupChunker({
                    tpool: dedup_chunker_tpool
                });
            },
            transform: function(data) {
                return Q.ninvoke(this.chunker, 'push', data);
            },
            flush: function() {
                return Q.ninvoke(this.chunker, 'flush');
            }
        }));

        ///////////////////////////////
        // PIPELINE: object encoding //
        ///////////////////////////////

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 10
            },
            init: function() {
                this.offset = 0;
                this.encoder = new native_util.ObjectCoding({
                    tpool: object_coding_tpool,
                    digest_type: 'sha384',
                    cipher_type: 'aes-256-gcm',
                    frag_digest_type: 'sha1',
                    data_frags: 1,
                    parity_frags: 0,
                    lrc_frags: 0,
                    lrc_parity: 0,
                });
            },
            transform: function(data) {
                var stream = this;
                return Q.ninvoke(this.encoder, 'encode', data)
                    .then(function(chunk) {
                        var part = {
                            start: start + stream.offset,
                            end: start + stream.offset + chunk.size,
                            upload_part_number: upload_part_number,
                            part_sequence_number: part_sequence_number,
                            chunk: chunk,
                        };
                        ++part_sequence_number;
                        stream.offset += chunk.size;
                        return part;
                    });
            },
        }));

        //////////////////////////////////////
        // PIPELINE: allocate part mappings //
        //////////////////////////////////////

        pipeline.pipe(new CoalesceStream({
            objectMode: true,
            highWaterMark: 30,
            max_length: 10,
            max_wait_ms: 1000,
        }));

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 10
            },
            transform: function(parts) {
                var stream = this;
                dbg.log0('upload_stream: allocating parts', parts.length);
                // send parts to server
                return self.client.object.allocate_object_parts({
                        bucket: params.bucket,
                        key: params.key,
                        parts: _.map(parts, function(part) {
                            var p = _.pick(part,
                                'start',
                                'end',
                                'upload_part_number',
                                'part_sequence_number');
                            p.chunk = _.pick(part.chunk,
                                'size',
                                'digest_type',
                                'cipher_type',
                                'data_frags',
                                'lrc_frags');
                            if (part.chunk.digest_buf) {
                                p.chunk.digest_b64 = part.chunk.digest_buf.toString('base64');
                            }
                            if (part.chunk.cipher_key) {
                                p.chunk.cipher_key_b64 = part.chunk.cipher_key.toString('base64');
                            }
                            if (part.chunk.cipher_iv) {
                                p.chunk.cipher_iv_b64 = part.chunk.cipher_iv.toString('base64');
                            }
                            if (part.chunk.cipher_auth_tag) {
                                p.chunk.cipher_auth_tag_b64 = part.chunk.cipher_auth_tag.toString('base64');
                            }
                            p.frags = _.map(part.chunk.frags, function(fragment) {
                                var f = _.pick(fragment, 'layer', 'layer_n', 'frag', 'digest_type');
                                if (fragment.digest_buf) {
                                    f.digest_b64 = fragment.digest_buf.toString('base64');
                                }
                                return f;
                            });
                            dbg.log3('upload_stream: allocating specific part ul#', p.upload_part_number, 'seq#', p.part_sequence_number);
                            return p;
                        })
                    })
                    .then(function(res) {
                        // push parts down the pipe
                        var part;
                        for (var i = 0; i < res.parts.length; i++) {
                            if (res.parts[i].dedup) {
                                part = parts[i];
                                part.dedup = true;
                                part.frags = null;
                                dbg.log0('upload_stream: DEDUP part', part.start);
                            } else {
                                part = res.parts[i].part;
                                // the buffers are kept in the object that we encoded
                                // so we need them accessible for writing
                                part.encoded_frags = parts[i].chunk.frags;
                                dbg.log0('upload_stream: allocated part', part.start);
                            }
                            stream.push(part);
                        }
                    });
            }
        }));

        /////////////////////////////////
        // PIPELINE: write part blocks //
        /////////////////////////////////

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 30
            },
            transform: function(part) {
                return Q.when(self._write_fragments(params.bucket, params.key, part))
                    .thenResolve(part);
            }
        }));

        /////////////////////////////
        // PIPELINE: finalize part //
        /////////////////////////////

        pipeline.pipe(new CoalesceStream({
            objectMode: true,
            highWaterMark: 30,
            max_length: 10,
            max_wait_ms: 1000,
        }));

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 10
            },
            transform: function(parts) {
                dbg.log0('upload_stream: finalize parts', parts.length);
                // send parts to server
                return self._finalize_sem.surround(function() {
                    return self.client.object.finalize_object_parts({
                        bucket: params.bucket,
                        key: params.key,
                        parts: _.map(parts, function(part) {
                            var p = _.pick(part,
                                'start',
                                'end',
                                'upload_part_number',
                                'part_sequence_number');
                            if (!part.dedup) {
                                p.block_ids = _.flatten(_.map(part.frags, function(fragment) {
                                    return _.map(fragment.blocks, function(block) {
                                        return block.block_md.id;
                                    });
                                }));
                            }
                            return p;
                        })
                    });
                });
            }
        }));

        //////////////////////////////////////////
        // PIPELINE: resolve, reject and notify //
        //////////////////////////////////////////

        pipeline.pipe(transformer({
            options: {
                objectMode: true,
                highWaterMark: 1
            },
            transform: function(part) {
                dbg.log0('upload_stream: completed part offset', part.start);
                dbg.log_progress(part.end / params.size);
                pipeline.notify({
                    event: 'part:after',
                    part: part
                });
            }
        }));

        return pipeline.run();
    });
};



/**
 *
 * _write_fragments
 *
 */
ObjectDriver.prototype._write_fragments = function(bucket, key, part) {
    var self = this;

    if (part.dedup) {
        dbg.log0('DEDUP', range_utils.human_range(part));
        return part;
    }

    var frags_map = _.indexBy(part.encoded_frags, get_frag_key);
    dbg.log0('_write_fragments', range_utils.human_range(part));
    dbg.log2('_write_fragments part', part);

    return Q.all(_.map(part.frags, function(fragment) {
        var frag_key = get_frag_key(fragment);
        return Q.all(_.map(fragment.blocks, function(block) {
            return self._attempt_write_block({
                bucket: bucket,
                key: key,
                start: part.start,
                end: part.end,
                part: part,
                block: block,
                buffer: frags_map[frag_key].block,
                frag_desc: size_utils.human_offset(part.start) + '-' + frag_key,
                remaining_attempts: 20,
            });
        }));
    }));
};



/**
 *
 * _write_block
 *
 * write a block to the storage node
 *
 */
ObjectDriver.prototype._attempt_write_block = function(params) {
    var self = this;
    var block = params.block;
    var frag_desc = params.frag_desc;
    dbg.log3('_attempt_write_block:', params);
    return self._write_block(block.block_md, params.buffer, frag_desc)
        .then(null, function( /*err*/ ) {
            if (params.remaining_attempts <= 0) {
                throw new Error('EXHAUSTED WRITE BLOCK', frag_desc);
            }
            params.remaining_attempts -= 1;
            var bad_block_params = _.extend(
                _.pick(params,
                    'bucket',
                    'key',
                    'start',
                    'end',
                    'upload_part_number',
                    'part_sequence_number'), {
                    block_id: block.block_md.id,
                    is_write: true,
                });
            dbg.log0('_attempt_write_block: write failed, report_bad_block.',
                'remaining attempts', params.remaining_attempts, frag_desc);
            return self.client.object.report_bad_block(bad_block_params)
                .then(function(res) {
                    dbg.log2('write block _attempt_write_block retry with', res.new_block);
                    // NOTE: we update the block itself in the part so
                    // that finalize will see this update as well.
                    block.block_md = res.new_block;
                    return self._attempt_write_block(params);
                });
        });
};


/**
 *
 * _write_block
 *
 * write a block to the storage node
 *
 */
ObjectDriver.prototype._write_block = function(block_md, buffer, desc) {
    var self = this;

    // use semaphore to surround the IO
    return self._block_write_sem.surround(function() {

        dbg.log1('write_block', desc,
            size_utils.human_size(buffer.length), block_md.id,
            'to', block_md.address);

        if (Math.random() < 0.5) throw new Error('testing error');

        return self.client.agent.write_block({
            block_md: block_md,
            data: buffer,
        }, {
            address: block_md.address,
            timeout: config.write_timeout,
        }).then(null, function(err) {
            console.error('FAILED write_block', desc,
                size_utils.human_size(buffer.length), block_md.id,
                'from', block_md.address);
            throw err;
        });

    });
};




// METADATA FLOW //////////////////////////////////////////////////////////////



/**
 *
 * GET_OBJECT_MD
 *
 * alternative to the default REST api read_object_md to use an MD cache.
 *
 * @param params (Object):
 *   - bucket (String)
 *   - key (String)
 * @param cache_miss (String): pass 'cache_miss' to force read
 */
ObjectDriver.prototype.get_object_md = function(params, cache_miss) {
    return this._object_md_cache.get(params, cache_miss);
};


/**
 *
 * _init_object_md_cache
 *
 */
ObjectDriver.prototype._init_object_md_cache = function() {
    var self = this;
    self._object_md_cache = new LRUCache({
        name: 'MDCache',
        max_length: 1000,
        expiry_ms: 60000, // 1 minute
        make_key: function(params) {
            return params.bucket + ':' + params.key;
        },
        load: function(params) {
            dbg.log1('MDCache: load', params.key, 'bucket', params.bucket);
            return self.client.object.read_object_md(params);
        }
    });
};




// READ FLOW //////////////////////////////////////////////////////////////////



/**
 *
 * OPEN_READ_STREAM
 *
 * returns a readable stream to the object.
 * see ObjectReader.
 *
 */
ObjectDriver.prototype.read_entire_object = function(params) {
    var self = this;
    return Q.Promise(function(resolve, reject) {
        var buffers = [];
        self.open_read_stream(params)
            .on('data', function(buffer) {
                console.log('read data', buffer.length);
                buffers.push(buffer);
            })
            .once('end', function() {
                var read_buf = Buffer.concat(buffers);
                console.log('read end', read_buf.length);
                resolve(read_buf);
            })
            .once('error', function(err) {
                console.log('read error', err);
                reject(err);
            });
    });
};



/**
 *
 * OPEN_READ_STREAM
 *
 * returns a readable stream to the object.
 * see ObjectReader.
 *
 */
ObjectDriver.prototype.open_read_stream = function(params, watermark) {
    return new ObjectReader(this, params, watermark || this.OBJECT_RANGE_ALIGN);
};


/**
 *
 * ObjectReader
 *
 * a Readable stream for the specified object and range.
 * params is also used for stream.Readable highWaterMark
 *
 */
function ObjectReader(client, params, watermark) {
    var self = this;
    Readable.call(self, {
        // highWaterMark Number - The maximum number of bytes to store
        // in the internal buffer before ceasing to read
        // from the underlying resource. Default=16kb
        highWaterMark: watermark,
        // encoding String - If specified, then buffers will be decoded to strings
        // using the specified encoding. Default=null
        encoding: null,
        // objectMode Boolean - Whether this stream should behave as a stream of objects.
        // Meaning that stream.read(n) returns a single value
        // instead of a Buffer of size n. Default=false
        objectMode: false,
    });
    self._client = client;
    self._bucket = params.bucket;
    self._key = params.key;
    self._pos = Number(params.start) || 0;
    self._end = typeof(params.end) === 'undefined' ? Infinity : Number(params.end);
}

// proper inheritance
util.inherits(ObjectReader, Readable);


/**
 * close the reader and stop returning anymore data
 */
ObjectReader.prototype.close = function() {
    this._closed = true;
    this.unpipe();
    this.emit('close');
};


/**
 * implement the stream's Readable._read() function.
 */
ObjectReader.prototype._read = function(requested_size) {
    var self = this;
    if (self._closed) {
        console.error('reader closed');
        return;
    }
    Q.fcall(function() {
            var end = Math.min(self._end, self._pos + requested_size);
            return self._client.read_object({
                bucket: self._bucket,
                key: self._key,
                start: self._pos,
                end: end,
            });
        })
        .then(function(buffer) {
            if (buffer && buffer.length) {
                self._pos += buffer.length;
                dbg.log0('reader pos', size_utils.human_offset(self._pos));
                self.push(buffer);
            } else {
                dbg.log0('reader finished', size_utils.human_offset(self._pos));
                self.push(null);
            }
        }, function(err) {
            console.error('reader error ' + err.stack);
            self.emit('error', err || 'reader error');
        });
};


/**
 *
 * READ_OBJECT
 *
 * @param params (Object):
 *   - bucket (String)
 *   - key (String)
 *   - start (Number) - object start offset
 *   - end (Number) - object end offset
 *
 * @return buffer (Promise to Buffer) - a portion of data.
 *      this is mostly likely shorter than requested, and the reader should repeat.
 *      null is returned on empty range or EOF.
 *
 */
ObjectDriver.prototype.read_object = function(params) {
    var self = this;

    dbg.log1('read_object1', range_utils.human_range(params));

    if (params.end <= params.start) {
        // empty read range
        return null;
    }

    var pos = params.start;
    var promises = [];

    while (pos < params.end && promises.length < self.READ_RANGE_CONCURRENCY) {
        var range = _.clone(params);
        range.start = pos;
        range.end = Math.min(
            params.end,
            range_utils.align_up_bitwise(pos + 1, self.OBJECT_RANGE_ALIGN_NBITS)
        );
        dbg.log2('read_object2', range_utils.human_range(range));
        promises.push(self._object_range_cache.get(range));
        pos = range.end;
    }

    return Q.all(promises).then(function(buffers) {
        return Buffer.concat(_.compact(buffers));
    });
};


/**
 *
 * _init_object_range_cache
 *
 */
ObjectDriver.prototype._init_object_range_cache = function() {
    var self = this;
    self._object_range_cache = new LRUCache({
        name: 'RangesCache',
        max_length: 128, // total 128 MB
        expiry_ms: 600000, // 10 minutes
        make_key: function(params) {
            var start = range_utils.align_down_bitwise(
                params.start, self.OBJECT_RANGE_ALIGN_NBITS);
            var end = start + self.OBJECT_RANGE_ALIGN;
            return params.bucket + ':' + params.key + ':' + start + ':' + end;
        },
        load: function(params) {
            var range_params = _.clone(params);
            range_params.start = range_utils.align_down_bitwise(
                params.start, self.OBJECT_RANGE_ALIGN_NBITS);
            range_params.end = range_params.start + self.OBJECT_RANGE_ALIGN;
            dbg.log0('RangesCache: load', range_utils.human_range(range_params), params.key);
            return self._read_object_range(range_params);
        },
        make_val: function(val, params) {
            if (!val) {
                dbg.log3('RangesCache: null', range_utils.human_range(params));
                return val;
            }
            var start = range_utils.align_down_bitwise(
                params.start, self.OBJECT_RANGE_ALIGN_NBITS);
            var end = start + self.OBJECT_RANGE_ALIGN;
            var inter = range_utils.intersection(
                start, end, params.start, params.end);
            if (!inter) {
                dbg.log3('RangesCache: empty', range_utils.human_range(params),
                    'align', range_utils.human_range({
                        start: start,
                        end: end
                    }));
                return null;
            }
            dbg.log3('RangesCache: slice', range_utils.human_range(params),
                'inter', range_utils.human_range(inter));
            return val.slice(inter.start - start, inter.end - start);
        },
    });
};



/**
 *
 * _read_object_range
 *
 * @param {Object} params:
 *   - bucket (String)
 *   - key (String)
 *   - start (Number) - object start offset
 *   - end (Number) - object end offset
 *
 * @return {Promise} buffer - the data. can be shorter than requested if EOF.
 *
 */
ObjectDriver.prototype._read_object_range = function(params) {
    var self = this;
    var obj_size;

    dbg.log2('_read_object_range', range_utils.human_range(params));

    return self._object_map_cache.get(params) // get meta data on object range we want to read
        .then(function(mappings) {
            obj_size = mappings.size;
            return Q.all(_.map(mappings.parts, self._read_object_part, self)); // get actual data from nodes
        })
        .then(function(parts) {
            // once all parts finish we can construct the complete buffer.
            var end = Math.min(obj_size, params.end);
            return combine_parts_buffers_in_range(parts, params.start, end);
        });
};


/**
 *
 * _init_object_map_cache
 *
 */
ObjectDriver.prototype._init_object_map_cache = function() {
    var self = this;
    self._object_map_cache = new LRUCache({
        name: 'MappingsCache',
        max_length: 1000,
        expiry_ms: 600000, // 10 minutes
        make_key: function(params) {
            var start = range_utils.align_down_bitwise(
                params.start, self.MAP_RANGE_ALIGN_NBITS);
            return params.bucket + ':' + params.key + ':' + start;
        },
        load: function(params) {
            var map_params = _.clone(params);
            map_params.start = range_utils.align_down_bitwise(
                params.start, self.MAP_RANGE_ALIGN_NBITS);
            map_params.end = map_params.start + self.MAP_RANGE_ALIGN;
            dbg.log1('MappingsCache: load', range_utils.human_range(params),
                'aligned', range_utils.human_range(map_params));
            return self.client.object.read_object_mappings(map_params);
        },
        make_val: function(val, params) {
            var mappings = _.clone(val);
            mappings.parts = _.cloneDeep(_.filter(val.parts, function(part) {
                var inter = range_utils.intersection(
                    part.start, part.end, params.start, params.end);
                if (!inter) {
                    dbg.log4('MappingsCache: filtered', range_utils.human_range(params),
                        'part', range_utils.human_range(part));
                    return false;
                }
                dbg.log3('MappingsCache: map', range_utils.human_range(params),
                    'part', range_utils.human_range(part));
                return true;
            }));
            return mappings;
        },
    });

};



/**
 * read one part of the object.
 */
ObjectDriver.prototype._read_object_part = function(part) {
    var self = this;
    dbg.log0('_read_object_part', range_utils.human_range(part));
    var frags_by_layer = _.groupBy(part.frags, 'layer');
    var data_frags = frags_by_layer.D;
    return Q.all(_.map(data_frags, function(fragment) {
            return self._read_fragment(part, fragment);
        }))
        .then(function() {
            var chunk = _.pick(part.chunk,
                'size',
                'digest_type',
                'cipher_type',
                'data_frags',
                'lrc_frags');
            if (part.chunk.digest_b64) {
                chunk.digest_buf = new Buffer(part.chunk.digest_b64, 'base64');
            }
            if (part.chunk.cipher_key_b64) {
                chunk.cipher_key = new Buffer(part.chunk.cipher_key_b64, 'base64');
            }
            if (part.chunk.cipher_iv_b64) {
                chunk.cipher_iv = new Buffer(part.chunk.cipher_iv_b64, 'base64');
            }
            if (part.chunk.cipher_auth_tag_b64) {
                chunk.cipher_auth_tag = new Buffer(part.chunk.cipher_auth_tag_b64, 'base64');
            }
            chunk.frags = _.map(part.frags, function(fragment) {
                var f = _.pick(fragment, 'layer', 'layer_n', 'frag', 'size', 'digest_type', 'block');
                f.layer_n = f.layer_n || 0;
                if (fragment.digest_b64) {
                    f.digest_buf = new Buffer(fragment.digest_b64, 'base64');
                }
                return f;
            });
            var decoder = new native_util.ObjectCoding({
                tpool: object_coding_tpool,
                digest_type: chunk.digest_type,
                cipher_type: chunk.cipher_type,
                data_frags: chunk.data_frags,
                lrc_frags: chunk.lrc_frags,
            });
            dbg.log2('GGG decode chunk', chunk);
            return Q.ninvoke(decoder, 'decode', chunk);
        }).then(function(decoded_chunk) {
            part.buffer = decoded_chunk.data;
            return part;
        });
};

ObjectDriver.prototype._read_fragment = function(part, fragment) {
    var self = this;
    var frag_desc = size_utils.human_offset(part.start) + '-' + get_frag_key(fragment);
    dbg.log0('read_fragment_blocks_chain', frag_desc);
    var next_block = 0;
    return read_next_block();

    function read_next_block() {
        if (next_block >= fragment.blocks.length) {
            dbg.error('READ FRAGMENT EXHAUSTED', frag_desc, fragment.blocks);
            throw new Error('READ FRAGMENT EXHAUSTED');
        }
        var block = fragment.blocks[next_block];
        next_block += 1;
        return self._blocks_cache.get(block.block_md)
            .then(finish, read_next_block);
    }

    function finish(buffer) {
        fragment.block = buffer;
    }
};

/**
 *
 * _init_blocks_cache
 *
 */
ObjectDriver.prototype._init_blocks_cache = function() {
    var self = this;
    self._blocks_cache = new LRUCache({
        name: 'BlocksCache',
        max_length: self.READ_CONCURRENCY, // very small, just to handle repeated calls
        expiry_ms: 600000, // 10 minutes
        make_key: function(block_md) {
            return block_md.id;
        },
        load: function(block_md) {
            dbg.log1('BlocksCache: load', block_md.id);
            return self._read_block(block_md);
        }
    });

};


/**
 *
 * _read_block
 *
 * read a block from the storage node
 *
 */
ObjectDriver.prototype._read_block = function(block_md) {
    var self = this;
    // use semaphore to surround the IO
    return self._block_read_sem.surround(function() {
        dbg.log0('read_block', block_md.id, 'from', block_md.address);
        return self.client.agent.read_block({
                block_md: block_md
            }, {
                address: block_md.address,
                timeout: config.read_timeout,
            })
            .then(function(res) {
                return res.data;
            }, function(err) {
                dbg.error('FAILED read_block', block_md.id, 'from', block_md.address);
                throw err;
            });
    });
};



// HTTP FLOW //////////////////////////////////////////////////////////////////



/**
 *
 * SERVE_HTTP_STREAM
 *
 * @param req: express request object
 * @param res: express response object
 * @param params (Object):
 *  - bucket (String)
 *  - key (String)
 */
ObjectDriver.prototype.serve_http_stream = function(req, res, params) {
    var self = this;
    var read_stream;

    // on disconnects close the read stream
    req.on('close', read_closer('request closed'));
    req.on('end', read_closer('request ended'));
    res.on('close', read_closer('response closed'));
    res.on('end', read_closer('response ended'));

    function read_closer(reason) {
        return function() {
            console.log('+++ serve_http_stream:', reason);
            if (read_stream) {
                read_stream.close();
                read_stream = null;
            }
        };
    }


    self.get_object_md(params).then(function(md) {
        res.header('Content-Type', md.content_type);
        res.header('Accept-Ranges', 'bytes');

        // range-parser returns:
        //      undefined (no range)
        //      -2 (invalid syntax)
        //      -1 (unsatisfiable)
        //      array (ranges with type)
        var range = req.range(md.size);

        if (!range) {
            dbg.log0('+++ serve_http_stream: send all');
            res.header('Content-Length', md.size);
            res.status(200);
            read_stream = self.open_read_stream(params, self.HTTP_PART_ALIGN);
            read_stream.pipe(res);
            return;
        }

        // return http 400 Bad Request
        if (range === -2) {
            dbg.log0('+++ serve_http_stream: bad range request', req.get('range'));
            res.status(400);
            return;
        }

        // return http 416 Requested Range Not Satisfiable
        if (range === -1 || range.type !== 'bytes' || range.length !== 1) {
            dbg.log0('+++ serve_http_stream: invalid range', range, req.get('range'));
            // let the client know of the relevant range
            res.header('Content-Length', md.size);
            res.header('Content-Range', 'bytes */' + md.size);
            res.status(416);
            return;
        }

        // return http 206 Partial Content
        var start = range[0].start;
        var end = range[0].end + 1; // use exclusive end

        // [disabled] truncate a single http request to limited size.
        // the idea was to make the browser fetch the next part of content
        // more quickly and only once it gets to play it, but it actually seems
        // to prevent it from properly keeping a video buffer, so disabled it.
        if (self.HTTP_TRUNCATE_PART_SIZE) {
            if (end > start + self.HTTP_PART_ALIGN) {
                end = start + self.HTTP_PART_ALIGN;
            }
            // snap end to the alignment boundary, to make next requests aligned
            end = range_utils.truncate_range_end_to_boundary_bitwise(
                start, end, self.HTTP_PART_ALIGN_NBITS);
        }

        dbg.log0('+++ serve_http_stream: send range',
            range_utils.human_range({
                start: start,
                end: end
            }), range);
        res.header('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + md.size);
        res.header('Content-Length', end - start);
        // res.header('Cache-Control', 'max-age=0' || 'no-cache');
        res.status(206);
        read_stream = self.open_read_stream(_.extend({
            start: start,
            end: end,
        }, params), self.HTTP_PART_ALIGN);
        read_stream.pipe(res);

        // when starting to stream also prefrech the last part of the file
        // since some video encodings put a chunk of video metadata in the end
        // and it is often requested once doing a video time seek.
        // see https://trac.ffmpeg.org/wiki/Encode/H.264#faststartforwebvideo
        if (start === 0) {
            dbg.log0('+++ serve_http_stream: prefetch end of file');
            var eof_len = 100;
            self.open_read_stream(_.extend({
                start: md.size > eof_len ? (md.size - eof_len) : 0,
                end: md.size,
            }, params), eof_len).pipe(devnull());
        }

    }, function(err) {
        console.error('+++ serve_http_stream: ERROR', err);
        res.status(500).send(err.message);
    });
};





// INTERNAL ///////////////////////////////////////////////////////////////////



function combine_parts_buffers_in_range(parts, start, end) {
    if (end <= start) {
        // empty read range
        return null;
    }
    if (!parts || !parts.length) {
        console.error('no parts for data', range_utils.human_range({
            start: start,
            end: end
        }));
        throw new Error('no parts for data');
    }
    var pos = start;
    var buffers = _.compact(_.map(parts, function(part) {
        var part_range = range_utils.intersection(part.start, part.end, pos, end);
        if (!part_range) {
            return;
        }
        var offset = part_range.start - part.start;
        if (part.chunk_offset) {
            offset += part.chunk_offset;
        }
        pos = part_range.end;
        return part.buffer.slice(offset, pos);
    }));
    if (pos !== end) {
        console.error('missing parts for data',
            range_utils.human_range({
                start: start,
                end: end
            }), 'pos', size_utils.human_offset(pos), parts);
        throw new Error('missing parts for data');
    }
    return Buffer.concat(buffers, end - start);
}

function get_frag_key(f) {
    return f.layer + '-' + f.frag;
}
