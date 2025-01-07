/* Copyright (C) 2016 NooBaa */
'use strict';

const S3Error = require('../s3_errors').S3Error;
const s3_utils = require('../s3_utils');

/**
 * http://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTpolicy.html
 */
async function put_bucket_policy(req) {
    let policy;
    try {
        policy = JSON.parse(JSON.stringify(req.body));
    } catch (error) {
        console.error('put_bucket_policy: Invalid JSON provided', error);
        throw new S3Error(S3Error.InvalidArgument);
    }
    try {
        await req.object_sdk.put_bucket_policy({ name: req.params.bucket, policy });
    } catch (error) {
        s3_utils.invalid_schema_to_aws_error(error);
    }
}

module.exports = {
    handler: put_bucket_policy,
    body: {
        invalid_error: S3Error.MalformedPolicyNotAJSON,
        type: 'json',
    },
    reply: {
        type: 'empty',
    },
};
