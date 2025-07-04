/* Copyright (C) 2016 NooBaa */
"use strict";

const _ = require('lodash');
const api = require('../../api');
const dbg = require('../../util/debug_module')(__filename);
const argv = require('minimist')(process.argv);

if (process.env.SUPPRESS_LOGS) {
    dbg.set_module_level(-5, 'core');
}

const { CloudFunction } = require('../utils/cloud_functions');
const { BucketFunctions } = require('../utils/bucket_functions');

const TEST_CTX = {
    client: null,
    aws_connection: null,
    azure_connection: null,
    compatible_v2: null,
    compatible_v4: null,
    s3_endpoint: '',
    s3_endpoint_https: '',
    mgmt_endpoint: '',
    bucket_mirror: 'ec.no.quota',
    bucket_spread: 'replica.with.quota',
    ns_bucket: 'ns.over.azure.aws',
    ns_cache_bucket: 'ns.cache.over.azure.aws'
};

async function main() {
    if (_.isUndefined(argv.mgmt_ip) || _.isUndefined(argv.mgmt_port)) {
        console.error('Missing mgmt paramters');
        process.exit(5);
    }

    if (_.isUndefined(argv.s3_ip) || _.isUndefined(argv.s3_port)) {
        console.error('Missing s3 endpoint paramters');
        process.exit(5);
    }

    // if (_.isUndefined(process.env.AWS_ACCESS) || _.isUndefined(process.env.AWS_SECRET)) {
    //     console.error('Missing env credentials');
    //     process.exit(5);
    // }

    TEST_CTX.s3_endpoint = `http://${argv.s3_ip}:${argv.s3_port}`;
    TEST_CTX.s3_endpoint_https = `https://${argv.s3_ip}:${argv.s3_port_https}`;
    TEST_CTX.mgmt_endpoint = `ws://${argv.mgmt_ip}:${argv.mgmt_port}`;

    dbg.log0('Running Sanity Build Test');
    await run_test();
    console.log('Finished Sanity Build Test Successfully');
    process.exit(0);
}

async function run_test() {
    await init_test();

    try {
        await create_configuration();
    } catch (error) {
        console.warn('Configuration testing failure, caught', error);
        process.exit(1);
    }

    try {
        await test_data();
    } catch (error) {
        console.warn('Data testing failure, caught', error);
        process.exit(1);
    }
}

async function init_test() {
    const auth_params = {
        email: 'demo@noobaa.com',
        password: 'DeMo1',
        system: 'demo'
    };
    TEST_CTX._rpc = api.new_rpc();
    TEST_CTX.client = TEST_CTX._rpc.new_client({
        address: TEST_CTX.mgmt_endpoint
    });
    await TEST_CTX.client.create_auth_token(auth_params);

    TEST_CTX.bucketfunc = new BucketFunctions(TEST_CTX.client);
    TEST_CTX.cloudfunc = new CloudFunction(TEST_CTX.client);

    // TEST_CTX.aws_connection = TEST_CTX.cloudfunc.getAWSConnection(process.env.AWS_ACCESS, process.env.AWS_SECRET);
    // TEST_CTX.aws_connection.name = `${TEST_CTX.aws_connection.name}12`;
    // TEST_CTX.azure_connection =
    //     TEST_CTX.cloudfunc.getAzureConnection(process.env.AZURE_ID, process.env.AZURE_SECRET, process.env.AZURE_ENDPOINT);
    // TEST_CTX.azure_connection.name = `${TEST_CTX.azure_connection.name}24`;
    TEST_CTX.compatible_v2 = {
        name: 'compatible_V2',
        endpoint_type: 'S3_COMPATIBLE',
        // here we are just using the same noobaa s3 endpoint
        endpoint: TEST_CTX.s3_endpoint,
        identity: '123',
        secret: 'abc',
        auth_method: 'AWS_V2'
    };
    TEST_CTX.compatible_v4 = {
        name: 'compatible_V4',
        endpoint_type: 'S3_COMPATIBLE',
        // doing the same as above but with https to have a different
        // endpoint for testing
        endpoint: TEST_CTX.s3_endpoint_https,
        identity: '123',
        secret: 'abc',
        auth_method: 'AWS_V4'
    };

}

//Create configuration on the server to test while upgrading
async function create_configuration() {

    //TODO:: verify _configure_system_address::os_utils.discover_k8s_services()

    //create resources and bucket
    await _create_resources_and_buckets();

    //Create various accounts
    await _create_accounts();

    await TEST_CTX.client.system.read_system();
}


async function _create_resources_and_buckets() {
    console.info('Creating Cloud Connections (AWS, Azure, Compatible V2/V4');
    // Create all supported connections
    // await TEST_CTX.cloudfunc.createConnection(TEST_CTX.aws_connection, 'AWS');
    // await TEST_CTX.cloudfunc.createConnection(TEST_CTX.azure_connection, 'Azure');
    await TEST_CTX.cloudfunc.createConnection(TEST_CTX.compatible_v2, 'S3_V2');
    await TEST_CTX.cloudfunc.createConnection(TEST_CTX.compatible_v4, 'S3_V4');
    //TODO: Add await TEST_CTX.cloudfunc.createConnection(TEST_CTX.gcloud_connection, 'GCP');

    //Create Cloud Resources
    // console.info('Creating Cloud Resources (AWS, Azure');
    // await TEST_CTX.cloudfunc.createCloudPool(TEST_CTX.aws_connection.name, 'AWS-Resource', 'QA-Bucket');
    // await TEST_CTX.cloudfunc.createCloudPool(TEST_CTX.azure_connection.name, 'AZURE-Resource', 'container3');

    //Create Compatible V2 and V4 buckets on the same system & then cloud resources on them
    console.info('Creating Cloud Resources (Compatibles V2/V4)');
    await TEST_CTX.bucketfunc.createBucket('compatible.v2');
    await TEST_CTX.bucketfunc.createBucket('compatible.v4');
    await TEST_CTX.cloudfunc.createCloudPool(TEST_CTX.compatible_v2.name, 'COMP-S3-V2-Resource', 'compatible.v2');
    await TEST_CTX.cloudfunc.createCloudPool(TEST_CTX.compatible_v4.name, 'COMP-S3-V4-Resource', 'compatible.v4');

    //Create bucket with various RP & Placement
    console.info('Creating Buckets');
    const buck1 = await TEST_CTX.bucketfunc.createBucket(TEST_CTX.bucket_mirror);
    const buck2 = await TEST_CTX.bucketfunc.createBucket(TEST_CTX.bucket_spread);

    console.info('Updating Tier to EC & Mirror');
    await TEST_CTX.bucketfunc.changeTierSetting(TEST_CTX.bucket_mirror, 4, 2); //EC 4+2
    await TEST_CTX.client.tier.update_tier({
        name: buck1.tiering.tiers[0].tier,
        attached_pools: ['COMP-S3-V4-Resource', 'COMP-S3-V2-Resource'],
        data_placement: 'MIRROR'
    });

    console.info('Setting Bucket Quota and Updating to Replica & Spread');
    await TEST_CTX.bucketfunc.setQuotaBucket(TEST_CTX.bucket_spread, 2, 'T');
    await TEST_CTX.client.tier.update_tier({
        name: buck2.tiering.tiers[0].tier,
        attached_pools: ['COMP-S3-V2-Resource', 'COMP-S3-V4-Resource'],
        data_placement: 'SPREAD'
    });

    //Create namespace resources
    console.info('Creating NS Resources');
    await TEST_CTX.cloudfunc.createNamespaceResource(TEST_CTX.compatible_v2.name, 'NSv2', 'first.bucket');
    await TEST_CTX.cloudfunc.createNamespaceResource(TEST_CTX.compatible_v4.name, 'NSv4', 'first.bucket');

    //Create namespace bucket
    console.info('Creating NS Buckets');
    await TEST_CTX.bucketfunc.createNamespaceBucket(TEST_CTX.ns_bucket, 'NSv2');
    await TEST_CTX.bucketfunc.updateNamesapceBucket(TEST_CTX.ns_bucket, 'NSv4', ['NSv2', 'NSv4']);
    await TEST_CTX.bucketfunc.createNamespaceBucket(TEST_CTX.ns_cache_bucket, 'NSv2', { ttl_ms: 60000 });
}

async function _create_accounts() {
    console.info('Creating Various Accounts Configurations');
    //no login with s3 access
    const ac1 = {
        name: 'ac_nologin_hasaccess',
        email: 'ac_nologin_hasaccess',
        has_login: false,
        s3_access: true,
        default_resource: 'COMP-S3-V2-Resource',
        allow_bucket_creation: true
    };

    const ac2 = {
        name: "ac_nologin_all_buckets",
        email: "ac_nologin_all_buckets@demo.com",
        has_login: false,
        must_change_password: true,
        s3_access: true,
        default_resource: 'COMP-S3-V2-Resource',
        allow_bucket_creation: true
    };

    const ac3 = {
        name: "ac_nologin_full",
        email: "ac_nologin_full@noobaa.com",
        has_login: false,
        must_change_password: false,
        s3_access: true,
        default_resource: 'COMP-S3-V2-Resource',
        allow_bucket_creation: true
    };

    const ac4 = {
        name: "ac_haslogin",
        email: "ac_haslogin@noobaa.com",
        has_login: true,
        password: "c1QiGkl2",
        must_change_password: false,
        s3_access: true,
        default_resource: 'COMP-S3-V2-Resource',
        allow_bucket_creation: true
    };

    const ac5 = {
        name: "ac_with_limit",
        email: "ac_with_limit@noobaa.com",
        has_login: false,
        must_change_password: false,
        s3_access: true,
        default_resource: 'COMP-S3-V2-Resource',
        allow_bucket_creation: true
    };
    const ac5_update = {
        email: ac4.email,
        ips: [
            { start: '10.0.0.1', end: '10.0.0.100' },
            { start: '127.0.0.1', end: '127.0.0.1' },
            { start: '78.10.124.210', end: '78.10.124.210' }
        ]
    };

    await TEST_CTX.client.account.create_account(ac1);
    await TEST_CTX.client.account.create_account(ac2);
    await TEST_CTX.client.account.create_account(ac3);
    await TEST_CTX.client.account.create_account(ac4);
    await TEST_CTX.client.account.create_account(ac5);
    await TEST_CTX.client.account.update_account(ac5_update);
}

async function test_data() {

    //test against mirror & ec -> TEST_CTX.bucket_mirror
    //test against spread * replica -> TEST_CTX.bucket_spread
    //test against NS -> TEST_CTX.ns_bucket

}

if (require.main === module) {
    main();
}

exports.run_test = run_test;
