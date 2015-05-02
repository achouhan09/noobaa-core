/* jshint node:true */
'use strict';

var _ = require('lodash');
var Q = require('q');
var db = require('./db');


/**
 *
 * BUCKET_SERVER
 *
 */
var bucket_server = {
    create_bucket: create_bucket,
    read_bucket: read_bucket,
    update_bucket: update_bucket,
    delete_bucket: delete_bucket,
    list_buckets: list_buckets,
};

module.exports = bucket_server;



/**
 *
 * CREATE_BUCKET
 *
 */
function create_bucket(req) {
    return resolve_tiering(req.rpc_params.tiering)
        .then(function(tiering) {
            var info = _.pick(req.rpc_params, 'name');
            info.system = req.system.id;
            if (tiering) {
                info.tiering = tiering;
            }
            return db.Bucket.create(info);
        })
        .then(null, db.check_already_exists(req, 'bucket'))
        .thenResolve();
}



/**
 *
 * READ_BUCKET
 *
 */
function read_bucket(req) {
    return Q.when(db.Bucket
            .findOne(get_bucket_query(req))
            .populate('tiering.tier')
            .exec())
        .then(db.check_not_deleted(req, 'bucket'))
        .then(function(bucket) {
            var reply = get_bucket_info(bucket);
            // TODO read bucket's storage and objects info
            reply.storage = {
                alloc: 0,
                used: 0,
            };
            reply.num_objects = 0;
            return reply;
        });
}



/**
 *
 * UPDATE_BUCKET
 *
 */
function update_bucket(req) {
    return resolve_tiering(req.rpc_params.tiering)
        .then(function(tiering) {
            var updates = {};
            if (req.rpc_params.new_name) {
                updates.name = req.rpc_params.new_name;
            }
            if (tiering) {
                updates.tiering = tiering;
            }
            return db.Bucket
                .findOneAndUpdate(get_bucket_query(req), updates)
                .exec();
        })
        .then(db.check_not_deleted(req, 'bucket'))
        .thenResolve();
}



/**
 *
 * DELETE_BUCKET
 *
 */
function delete_bucket(req) {
    var updates = {
        deleted: new Date()
    };
    return Q.when(db.Bucket
            .findOneAndUpdate(get_bucket_query(req), updates)
            .exec())
        .then(db.check_not_found(req, 'bucket'))
        .thenResolve();
}



/**
 *
 * LIST_BUCKETS
 *
 */
function list_buckets(req) {
    return Q.when(db.Bucket
            .find({
                system: req.system.id,
                deleted: null,
            })
            .populate('tiering.tier')
            .exec())
        .then(function(buckets) {
            return {
                buckets: _.map(buckets, function(bucket) {
                    return _.pick(bucket, 'name');
                })
            };
        });
}



// UTILS //////////////////////////////////////////////////////////


function get_bucket_query(req) {
    return {
        system: req.system.id,
        name: req.rpc_params.name,
        deleted: null,
    };
}

function get_bucket_info(bucket) {
    var reply = _.pick(bucket, 'name');
    if (bucket.tiering) {
        reply.tiering = _.map(bucket.tiering, function(t) {
            return t.tier.name;
        });
    }
    return reply;
}

function resolve_tiering(tiering) {
    if (!tiering) return Q.resolve();
    return Q.when(db.Tier
            .find({
                name: {
                    $in: tiering
                },
                deleted: null,
            })
            .exec())
        .then(function(tiers) {
            var tiers_by_name = _.indexBy(tiers, 'name');
            return _.map(tiering, function(name) {
                var tier = tiers_by_name[name];
                if (!tier) {
                    console.log('TIER NOT FOUND', name);
                    throw new Error('missing tier');
                }
                return {
                    tier: tier
                };
            });
        });
}
