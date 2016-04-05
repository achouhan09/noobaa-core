// this module is written for both nodejs.
'use strict';

var _ = require('lodash');
var P = require('../util/promise');
var jwt = require('jsonwebtoken');
var dbg = require('../util/debug_module')(__filename);
var system_store = require('./stores/system_store');
var bcrypt = require('bcrypt');
var S3Auth = require('aws-sdk/lib/signers/s3');
var s3_util = require('../util/s3_utils');
var s3_auth = new S3Auth();

/**
 *
 * AUTH_SERVER
 *
 */
var auth_server = {

    create_auth: create_auth,
    read_auth: read_auth,
    create_access_key_auth: create_access_key_auth,

    /**
     * authorize is exported to be used as an express middleware
     * it reads and prepares the authorized info on the request (req.auth).
     */
    authorize: authorize
};

module.exports = auth_server;



/**
 *
 * CREATE_AUTH
 *
 * authenticate and return an authorized token.
 *
 * the simplest usage is to send email & password, which will be verified
 * to match the existing account, and will return an authorized token containing the account.
 *
 * another usage is to get a system authorization by passing system_name.
 * one option is to combine with email & password, and another is to call without
 * email and password but with existing authorization token which contains
 * a previously authenticated account.
 *
 */
function create_auth(req) {

    var email = req.rpc_params.email;
    var password = req.rpc_params.password;
    var system_name = req.rpc_params.system;
    var role_name = req.rpc_params.role;
    // var expiry = req.rpc_params.expiry;
    var authenticated_account;
    var target_account;
    var system;

    return P.fcall(function() {

        // if email is not provided we skip finding target_account by email
        // and use the current auth account as the authenticated_account
        if (!email) return;

        // consider email not found the same as bad password to avoid phishing attacks.
        target_account = system_store.data.accounts_by_email[email];
        if (!target_account) throw req.unauthorized('credentials account not found');

        // when password is not provided it means we want to give authorization
        // by the currently authorized to another specific account instead of
        // using credentials.
        if (!password) return;

        // use bcrypt to verify password
        return P.nfcall(bcrypt.compare, password, target_account.password)
            .then(function(match) {
                if (!match) throw req.unauthorized('password mismatch');
                // authentication passed!
                // so this account is the authenticated_account
                authenticated_account = target_account;
            });

    }).then(function() {

        // if both accounts were resolved (they can be the same account),
        // then we can skip loading the current authorized account
        if (!authenticated_account || !target_account) {
            // find the current authorized account and assign
            if (!req.auth || !req.auth.account_id) {
                throw req.unauthorized('no account_id in auth and no credetials');
            }

            var account_arg = system_store.data.get_by_id(req.auth.account_id);
            target_account = target_account || account_arg;
            authenticated_account = authenticated_account || account_arg;

        }

        // check the accounts are valid
        if (!authenticated_account || authenticated_account.deleted) {
            throw req.unauthorized('authenticated account not found');
        }
        if (!target_account || target_account.deleted) {
            throw req.unauthorized('target account not found');
        }

        // system is optional, and will not be included in the token if not provided
        if (system_name) {

            // find system by name
            system = system_store.data.systems_by_name[system_name];
            if (!system || system.deleted) throw req.unauthorized('system not found');

            // find the role of authenticated_account in the system
            var roles = system.roles_by_account &&
                system.roles_by_account[authenticated_account._id];

            // now approve the role -
            if (
                // support account  can do anything
                authenticated_account.is_support ||
                // system owner can do anything
                String(system.owner) === String(authenticated_account._id) ||
                // system admin can do anything
                _.includes(roles, 'admin') ||
                // non admin is not allowed to delegate roles to other accounts
                (role_name && _.includes(roles, role_name) &&
                    String(target_account._id) === String(authenticated_account._id))) {
                // "system admin" can use any role
                role_name = role_name || 'admin';
            } else {
                throw req.unauthorized('account role not allowed');
            }
        }

        var token = req.make_auth_token({
            account_id: target_account._id,
            system_id: system && system._id,
            role: role_name,
            extra: req.rpc_params.extra,
        });

        return {
            token: token
        };
    });
}


/**
 *
 * CREATE_ACCESS_KEY_AUTH
 *
 * Access and Secret key authentication.
 *
 * We use it to authenticate requests from S3 REST server and Agents.
 *
 * S3 REST requests
 *
 * The authorization header or query params includes the access key and
 * a signature.The signature uses the secret key and a string that includes
 * part of the request headers (string_to_sign).
 * The REST server forwards this authorization information to the web server.
 * The Server simply validate (by signing the string_to_sign and comparing
 * to the provided signature).
 * This allows us to avoid saving access key and secret key on the s3 rest.
 * It also allows s3 rest server to serve more than one system.
 *
 * Agent
 *
 * The agent sends authorization information, we identify the system and
 * returns token that will be used from now on (exactly like we used it before)
 *
 */
function create_access_key_auth(req) {
    //console.warn("evg evg evg REQ:NOOBAA_V4 STRING: " ,req.noobaa_v4);

    var access_key = req.rpc_params.access_key;
    var string_to_sign = req.rpc_params.string_to_sign;
    var signature = req.rpc_params.signature;
    //var expiry = req.rpc_params.expiry;
    //var noobaa_v4 = req.rpc_params.extra;
    //var secret_key;

    var account = _.find(system_store.data.accounts, function(acc) {
        //console.warn(".accounts: " , acc);
        if(acc.noobaa_access_keys)
        {
            return acc.noobaa_access_keys.access_key.toString() === access_key.toString();
        }
        else {
            return false;
        }
    });

    if (!account || account.deleted) {
        throw req.unauthorized('account not found');
    }
    dbg.log0('create_access_key_auth:',
        'account.name', account.email,
        'access_key', access_key,
        'string_to_sign', string_to_sign,
        'signature', signature);

        //console.warn('EVG EVG EVG EVG EVG SYSTEM ACCESS KEYS ARE: ', _.find(system.access_keys, 'access_key', access_key));
        //console.warn('account is: ', account);
    //secret_key = account.noobaa_access_keys.secret_key;
    //console.warn('secret_key is: ', secret_key);

    //TODO JUST FOR NOW
    //console.warn('EVG EVG EVG EVG EVG SECRET_KEY IS: ', secret_key);
    /*var s3_signature;

    if(noobaa_v4){
        s3_signature = s3_util.noobaa_signature_v4({
            xamzdate: noobaa_v4.xamzdate,
            region: noobaa_v4.region,
            service: noobaa_v4.service,
            string_to_sign: string_to_sign,
            secret_key: secret_key
        });
    }
    else {
        s3_signature = s3_auth.sign(secret_key ,string_to_sign);//secret_key, string_to_sign);
        //signature = s3_auth.sign('abcd', string_to_sign);
        //console.warn('EVG EVG EVG EVG EVG SIGNATURE COMP: ', s3_signature, signature);

    }
    //var s3_signature = s3_auth.sign(secret_key, string_to_sign);
    dbg.log0('signature for access key:', access_key, 'string:', string_to_sign, ' is', s3_signature);

    //TODO:bring back ASAP!!!! - temporary for V4 "Support"
    //
    if (signature === s3_signature) {
        dbg.log0('s3 authentication test passed!!!');
    } else {
        throw req.unauthorized('SignatureDoesNotMatch');
    }*/

    //console.warn('system_store.data.systems is: ', system_store.data.roles);


    var role = _.find(system_store.data.roles, function(role) {
        //return _.find(role.account, function(acc) {
            return role.account._id.toString() === account._id.toString();
        //});
    });

    if (!role || role.deleted) {
        throw req.unauthorized('role not found');
    }

    var system = role.system;

    if (!system) {
        throw req.unauthorized('system not found');
    }

    var auth_extra;
    if(req.rpc_params.extra) {
        auth_extra = req.rpc_params.extra;
        auth_extra.signature = req.rpc_params.signature;
        auth_extra.string_to_sign = req.rpc_params.string_to_sign;
    }
    else {
        auth_extra = {
            signature:  req.rpc_params.signature,
            string_to_sign: req.rpc_params.string_to_sign
        };
    }

    var token = req.make_auth_token({
        system_id: system && system._id,
        account_id: account._id,
        role: 'admin',
        s3_auth: auth_extra,
    });
    dbg.log0('ACCESS TOKEN:', token);
    return {
        token: token
    };
}



/**
 *
 * READ_AUTH
 *
 */
function read_auth(req) {
    if (!req.auth) {
        return {};
    }

    var reply = _.pick(req.auth, 'role', 'extra');
    if (req.account) {
        reply.account = _.pick(req.account, 'name', 'email');
        if (req.account.is_support) {
            reply.account.is_support = true;
        }
    }
    if (req.system) {
        reply.system = _.pick(req.system, 'name');
    }
    return reply;
}



/**
 *
 * AUTHORIZE
 *
 * rpc authorizer to parse and verify the auth token
 * and assign the info in req.auth.
 *
 */
function authorize(req) {
//console.warn('CHECKING AUTHORIZE CONNECT');
    _prepare_auth_request(req);
    var auth_token_obj;

//console.warn('evg evg evg req.auth_token = ',req.auth_token);
//console.warn('evg evg evg req.noobaa_v4 = ',req.noobaa_v4);
//console.warn('evg evg evg req.rpc_params = ',req.rpc_params);
//console.warn('Auth Token Object1: ', auth_token_obj);

    if (req.auth_token) {
        //console.warn('Auth Token Object2: ', auth_token_obj);

        try {
            var auth_token;
            if (req.auth_token.indexOf('auth_token') > 0) {
                auth_token_obj = JSON.parse(req.auth_token);
                //console.warn('Auth Token Object3: ', auth_token_obj);
                auth_token = auth_token_obj.auth_token;
            } else {
                //console.warn('Auth Token Object4: ', req.auth_token);

                auth_token = req.auth_token;
            }
            req.auth = jwt.verify(auth_token, process.env.JWT_SECRET);
            auth_token_obj = req.auth;
            //console.warn('Auth Token Object5: ', req.auth);

        } catch (err) {
            dbg.error('AUTH JWT VERIFY FAILED', req, err);
            throw {
                statusCode: 401,
                data: 'unauthorized'
            };
        }
    }

    if (req.method_api.auth !== false) {
        dbg.log0('authorize:', req.method_api.auth, req.srv);
        req.load_auth();

        //console.warn('AUTHORIZE S3 AUTH auth_token_obj: ', auth_token_obj);
        //if request request has access signature, validate the signature
        if (auth_token_obj && auth_token_obj.s3_auth) {
            var s3_params = auth_token_obj.s3_auth;
            var account = system_store.data.get_by_id(auth_token_obj.account_id);
            var secret_key = account.noobaa_access_keys.secret_key;
            var s3_signature;

            if(s3_params.string_to_sign.indexOf('AWS4') > -1){
                s3_signature = s3_util.noobaa_signature_v4({
                    xamzdate: s3_params.xamzdate,
                    region: s3_params.region,
                    service: s3_params.service,
                    string_to_sign: s3_params.string_to_sign,
                    secret_key: secret_key
                });
            }
            else {
                s3_signature = s3_auth.sign(secret_key, s3_params.string_to_sign);//secret_key, string_to_sign);
                //signature = s3_auth.sign('abcd', string_to_sign);
                //console.warn('EVG EVG EVG EVG EVG SIGNATURE COMP: ', s3_signature, signature);

            }
            //var s3_signature = s3_auth.sign(secret_key, string_to_sign);
            dbg.log0('signature for access key:', account.noobaa_access_keys.access_key, 'string:', s3_params.string_to_sign, ' is', s3_signature);

            //TODO:bring back ASAP!!!! - temporary for V4 "Support"
            //
            if (s3_params.signature === s3_signature) {
                dbg.log0('s3 authentication test passed!!!');
            } else {
                throw req.unauthorized('SignatureDoesNotMatch');
            }
            // var secret_key = _.result(_.find(req.system.access_keys, 'access_key', auth_token_obj.access_key), 'secret_key');
            // var s3_signature = s3_auth.sign(secret_key, auth_token_obj.string_to_sign);

            //TODO:bring back ASAP!!!! - temporary for V4 "Support"

            // if (auth_token_obj.signature === s3_signature) {
            //     dbg.log3('Access key authentication (per request) test passed !!!');
            // } else {
            //     dbg.error('Signature for access key:', auth_token_obj.access_key, 'computed:', s3_signature, 'expected:', auth_token_obj.signature);
            //     throw req.unauthorized('SignatureDoesNotMatch');
            // }
        }
    }
}



/**
 *
 * _prepare_auth_request()
 *
 * set utility functions on the request to be able to use in other api's.
 * see the function docs below.
 *
 */
function _prepare_auth_request(req) {

    // we allow to authorize once per connection -
    // if the request did not send specific token, use the conn level token.
    if (!req.auth_token) {
        // TODO better save req.connection.auth parsed instead of reparsing the token again
        req.auth_token = req.connection.auth_token;
    }

    /**
     *
     * req.load_auth()
     *
     * verifies that the request auth has a valid account and sets req.account.
     * verifies that the request auth has a valid system
     * and sets req.system and req.role.
     *
     * @param <Object> options:
     *      - <Boolean> account: if false don't fail if there is no account in req.auth
     *      - <Boolean> system: if false don't fail if there is no system in req.auth
     *      - <Array> roles: acceptable roles
     */
    req.load_auth = function() {
        var options = this.method_api.auth || {};

        dbg.log1('load_auth:', options, req.auth);
        if (req.auth) {
            req.account = system_store.data.get_by_id(req.auth.account_id);
            req.system = system_store.data.get_by_id(req.auth.system_id);
            req.role = req.auth.role;
        }
        var ignore_missing_account = !options.account;
        var ignore_missing_system = (options.system === false);
        if (!ignore_missing_account) {
            // check that auth has account
            if (!req.account) {
                throw req.unauthorized('auth account not found ' + (req.auth && req.auth.account_id));
            }
        }
        if (!ignore_missing_system) {
            // check that auth contains system
            if (!req.system) {
                throw req.unauthorized('auth system not found ' + (req.auth && req.auth.system_id));
            }

            // check that auth contains valid system role or the account is support
            if (!(req.account && req.account.is_support) &&
                !_.includes(options.system, req.auth.role)) {
                throw req.unauthorized('auth role not allowed in system');
            }
        }
        dbg.log3('load auth system:', req.system);
    };


    /**
     *
     * req.make_auth_token()
     *
     * make jwt token (json web token) used for authorization.
     *
     * @param <Object> options:
     *      - account_id
     *      - system_id
     *      - role
     *      - extra
     *      - expiry
     * @return <String> token
     */
    req.make_auth_token = function(options) {
        var auth = _.pick(options, 'account_id', 'system_id', 'role', 'extra', 's3_auth');

        // don't incude keys if value is falsy, to minimize the token size
        auth = _.omitBy(auth, function(value) {
            return !value;
        });

        // set expiry if provided
        var jwt_options = {};
        if (options.expiry) {
            jwt_options.expiresInMinutes = options.expiry / 60;
        }
        // create and return the signed token
        return jwt.sign(auth, process.env.JWT_SECRET, jwt_options);
    };


    /**
     *
     * req.unauthorized()
     *
     * the auth server uses only unauthorized error to all auth failures
     * without sending an explicit message, only server is logging the reason,
     * to prevent phishing attacks.
     *
     */
    req.unauthorized = function(reason) {
        return req.rpc_error('UNAUTHORIZED', '', {
            reason: reason
        });
    };


    /**
     *
     * req.forbidden()
     *
     * reply that the request is not permitted.
     *
     */
    req.forbidden = function(reason) {
        return req.rpc_error('FORBIDDEN', '', {
            reason: reason
        });
    };

}




// UTILS //////////////////////////////////////////////////////////
