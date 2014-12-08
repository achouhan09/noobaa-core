'use strict';

var rest_api = require('../util/rest_api');


/**
 *
 * NODE API
 *
 */
module.exports = rest_api({

    name: 'node_api',

    methods: {

        create_node: {
            method: 'POST',
            path: '/node',
            params: {
                $ref: '/node_api/definitions/node_config'
            },
            reply: {
                type: 'object',
                required: ['id', 'token'],
                properties: {
                    id: {
                        type: 'string'
                    },
                    token: {
                        type: 'string'
                    }
                }
            },
            auth: {
                system: ['admin', 'create_node']
            }
        },

        read_node: {
            method: 'GET',
            path: '/node/:name',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string'
                    }
                }
            },
            reply: {
                $ref: '/node_api/definitions/node_full_info'
            },
            auth: {
                system: 'admin'
            }
        },

        update_node: {
            method: 'PUT',
            path: '/node/:name',
            params: {
                $ref: '/node_api/definitions/node_config'
            },
            auth: {
                system: 'admin'
            }
        },

        delete_node: {
            method: 'DELETE',
            path: '/node/:name',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                    },
                }
            },
            auth: {
                system: 'admin'
            }
        },

        read_node_maps: {
            method: 'GET',
            path: '/node_maps/:name',
            params: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string'
                    }
                }
            },
            reply: {
                type: 'object',
                required: ['node', 'objects'],
                properties: {
                    node: {
                        $ref: '/node_api/definitions/node_full_info'
                    },
                    objects: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: [],
                            properties: {
                                key: {
                                    type: 'string'
                                },
                                parts: {
                                    type: 'array',
                                    items: {
                                        $ref: '/object_api/definitions/object_part_info'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        },

        list_nodes: {
            method: 'GET',
            path: '/node',
            params: {
                type: 'object',
                required: [],
                properties: {
                    query: {
                        type: 'object',
                        required: [],
                        properties: {
                            tier: {
                                type: 'string'
                            },
                            name: {
                                // regexp
                                type: 'string'
                            },
                            geolocation: {
                                // regexp
                                type: 'string'
                            },
                        }
                    },
                    skip: {
                        type: 'integer'
                    },
                    limit: {
                        type: 'integer'
                    },
                }
            },
            reply: {
                type: 'object',
                required: ['nodes'],
                properties: {
                    nodes: {
                        type: 'array',
                        items: {
                            $ref: '/node_api/definitions/node_full_info'
                        }
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        },


        group_nodes: {
            method: 'GET',
            path: '/group',
            params: {
                type: 'object',
                required: [],
                properties: {
                    group_by: {
                        type: 'object',
                        required: [],
                        properties: {
                            tier: {
                                type: 'boolean'
                            },
                            geolocation: {
                                type: 'boolean'
                            },
                        }
                    },
                }
            },
            reply: {
                type: 'object',
                required: ['groups'],
                properties: {
                    groups: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['count'],
                            properties: {
                                tier: {
                                    type: 'string'
                                },
                                geolocation: {
                                    type: 'string'
                                },
                                count: {
                                    type: 'integer'
                                },
                                storage: {
                                    $ref: '/system_api/definitions/storage_info'
                                },
                            }
                        }
                    }
                }
            },
            auth: {
                system: 'admin'
            }
        },



        heartbeat: {
            method: 'PUT',
            path: '/heartbeat/:id',
            params: {
                type: 'object',
                required: [
                    'id',
                    'port',
                    'storage',
                    'device_info',
                ],
                properties: {
                    id: {
                        type: 'string'
                    },
                    geolocation: {
                        type: 'string'
                    },
                    ip: {
                        type: 'string'
                    },
                    port: {
                        type: 'integer'
                    },
                    storage: {
                        $ref: '/system_api/definitions/storage_info'
                    },
                    device_info: {
                        type: 'object',
                        additionalProperties: true,
                    },
                }
            },
            reply: {
                type: 'object',
                required: ['storage'],
                properties: {
                    storage: {
                        $ref: '/system_api/definitions/storage_info'
                    },
                }
            },
            auth: {
                system: ['admin', 'agent']
            }
        },


    },


    definitions: {

        node_config: {
            type: 'object',
            required: ['name', 'tier'],
            properties: {
                name: {
                    type: 'string',
                },
                tier: {
                    type: 'string',
                },
                is_server: {
                    type: 'boolean',
                },
                geolocation: {
                    type: 'string',
                },
                storage_alloc: {
                    type: 'integer'
                },
            }
        },


        node_full_info: {
            type: 'object',
            required: [
                'id',
                'name',
                'geolocation',
                'ip',
                'port',
                'online',
                'heartbeat',
                'storage',
                'device_info',
            ],
            properties: {
                id: {
                    type: 'string'
                },
                name: {
                    type: 'string'
                },
                geolocation: {
                    type: 'string'
                },
                ip: {
                    type: 'string'
                },
                port: {
                    type: 'integer'
                },
                online: {
                    type: 'boolean',
                },
                heartbeat: {
                    type: 'string',
                    format: 'date',
                },
                storage: {
                    $ref: '/system_api/definitions/storage_info'
                },
                device_info: {
                    type: 'object',
                    additionalProperties: true,
                }
            }
        }

    }

});
