// module targets: nodejs & browserify
'use strict';

var _ = require('lodash');
var path = require('path');
var util = require('util');

/**
 *
 * DBG
 *
 * debugging tools which are available also in production.
 * use in your module as follows:
 *
 * var dbg = require('dbg')(__filename);
 * dbg.log_level = 1;
 * dbg.log0('this will print since log_level >= 0');
 * dbg.log1('this will print since log_level >= 1');
 * dbg.log2('this will not print unless log_level >= 2');
 * dbg.log3('this will not print unless log_level >= 3');
 *
 */
module.exports = DebugContext;

// keep all contexes in global map
DebugContext.ctx = {};


function DebugContext(module) {
    // allow calling this ctor without new keyword
    if (!(this instanceof DebugContext)) {
        return new DebugContext(module);
    }

    // use the module's filename to detect a debug context name
    // take the relative path to the projects source dir
    console.log(__dirname, module);
    var name = path.relative(path.resolve(__dirname, '..'), module);

    // replacing any non-word chars with _ to make it a qualified js name
    // to make it friendlier inside REPL context:
    // repl> dbg.ctx.server.log_level = 1
    name = name.replace(/\W/g, '_');

    // link from context map to this context
    DebugContext.ctx[name] = this;
    // link each context to the global to make it easily accessible
    this.ctx = DebugContext.ctx;

    this.name = name;
    this.log_level = 0;
}

DebugContext.prototype.log0 = function() {
    if (this.log_level >= 0) {
        console.log.apply(console, arguments);
    }
};

DebugContext.prototype.log1 = function() {
    if (this.log_level >= 1) {
        console.log.apply(console, arguments);
    }
};

DebugContext.prototype.log2 = function() {
    if (this.log_level >= 2) {
        console.log.apply(console, arguments);
    }
};

DebugContext.prototype.log3 = function() {
    if (this.log_level >= 3) {
        console.log.apply(console, arguments);
    }
};

DebugContext.prototype.log4 = function() {
    if (this.log_level >= 4) {
        console.log.apply(console, arguments);
    }
};

DebugContext.prototype.log_progress = function(fraction) {
    var percents = (100 * fraction) | 0;
    var msg = 'progress: ' + percents.toFixed(0) + ' %';
    if (!process.stdout) {
        console.log(msg);
    } else {
        process.stdout.write(msg + '\r');
    }
};
