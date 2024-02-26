/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2016-present The uBlock Origin authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global browser, indexedDB */

'use strict';

/******************************************************************************/

import lz4Codec from './lz4.js';
import webext from './webext.js';
import { ubolog } from './console.js';
import * as scuo from './scuo-serializer.js';

/******************************************************************************/

// The code below has been originally manually imported from:
// Commit: https://github.com/nikrolls/uBlock-Edge/commit/d1538ea9bea89d507219d3219592382eee306134
// Commit date: 29 October 2016
// Commit author: https://github.com/nikrolls
// Commit message: "Implement cacheStorage using IndexedDB"

// The original imported code has been subsequently modified as it was not
// compatible with Firefox.
// (a Promise thing, see https://github.com/dfahlander/Dexie.js/issues/317)
// Furthermore, code to migrate from browser.storage.local to vAPI.storage
// has been added, for seamless migration of cache-related entries into
// indexedDB.

// https://bugzilla.mozilla.org/show_bug.cgi?id=1371255
//   Firefox-specific: we use indexedDB because browser.storage.local() has
//   poor performance in Firefox.
// https://github.com/uBlockOrigin/uBlock-issues/issues/328
//   Use IndexedDB for Chromium as well, to take advantage of LZ4
//   compression.
// https://github.com/uBlockOrigin/uBlock-issues/issues/399
//   Revert Chromium support of IndexedDB, use advanced setting to force
//   IndexedDB.
// https://github.com/uBlockOrigin/uBlock-issues/issues/409
//   Allow forcing the use of webext storage on Firefox.

const STORAGE_NAME = 'uBlock0CacheStorage';

// Default to webext storage.
const storageLocal = webext.storage.local;


const keysFromGetArg = arg => {
    if ( arg === null || arg === undefined ) { return []; }
    const type = typeof arg;
    if ( type === 'string' ) { return [ arg ]; }
    if ( Array.isArray(arg) ) { return arg; }
    if ( type !== 'object' ) { return; }
    return Object.keys(arg);
};

// Cache API is subject to quota so we will use it only for what is key
// performance-wise
const shouldCache = bin => {
    const out = {};
    for ( const key of Object.keys(bin) ) {
        if ( key.startsWith('cache/') ) {
            if ( /^cache\/(compiled|selfie)\//.test(key) === false ) { continue; }
        }
        out[key] = bin[key];
    }
    return out;
};

/*******************************************************************************
 * 
 * Extension storage
 * 
 * Always available.
 * 
 * */

const cacheStorage = (( ) => {

    const LARGE = 16384;

    const compress = async (key, data) => {
        const isLarge = typeof data === 'string' && data.length >= LARGE;
        const after = await scuo.serializeAsync(data, {
            compress: isLarge,
            multithreaded: isLarge,
        });
        return { key, data: after };
    };

    const decompress = async (key, data) => {
        if ( scuo.canDeserialize(data) === false ) {
            return { key, data };
        }
        const isLarge = data.length >= LARGE;
        const after = await scuo.deserializeAsync(data, {
            multithreaded: isLarge,
        });
        return { key, data: after };
    };

    return {
        name: 'browser.storage.local',

        get(arg) {
            const keys = arg;
            return cacheAPI.get(keysFromGetArg(arg)).then(bin => {
                if ( bin !== undefined ) { return bin; }
                return storageLocal.get(keys).catch(reason => {
                    ubolog(reason);
                });
            }).then(bin => {
                if ( bin instanceof Object === false ) { return bin; }
                const promises = [];
                for ( const key of Object.keys(bin) ) {
                    promises.push(decompress(key, bin[key]));
                }
                return Promise.all(promises);
            }).then(results => {
                const bin = {};
                for ( const { key, data } of results ) {
                    bin[key] = data;
                }
                return bin;
            }).catch(reason => {
                ubolog(reason);
            });
        },

        async keys(regex) {
            const results = await Promise.all([
                cacheAPI.keys(regex),
                storageLocal.get(null).catch(( ) => {}),
            ]);
            const keys = new Set(results[0]);
            const bin = results[1] || {};
            for ( const key of Object.keys(bin) ) {
                if ( regex && regex.test(key) === false ) { continue; }
                keys.add(key);
            }
            return keys;
        },

        async set(keyvalStore) {
            const keys = Object.keys(keyvalStore);
            if ( keys.length === 0 ) { return; }
            const promises = [];
            for ( const key of keys ) {
                promises.push(compress(key, keyvalStore[key]));
            }
            const results = await Promise.all(promises);
            const serializedStore = {};
            for ( const { key, data } of results ) {
                serializedStore[key] = data;
            }
            cacheAPI.set(shouldCache(serializedStore));
            return storageLocal.set(serializedStore).catch(reason => {
                ubolog(reason);
            });
        },

        remove(...args) {
            cacheAPI.remove(...args);
            return storageLocal.remove(...args).catch(reason => {
                ubolog(reason);
            });
        },

        clear(...args) {
            cacheAPI.clear(...args);
            return storageLocal.clear(...args).catch(reason => {
                ubolog(reason);
            });
        },

        async migrate(cacheAPI) {
            if ( cacheAPI === 'browser.storage.local' ) { return; }
            if ( cacheAPI !== 'indexedDB' ) {
                if ( vAPI.webextFlavor.soup.has('firefox') === false ) { return; }
                if ( browser.extension.inIncognitoContext !== true ) { return; }
            }
            // Copy all items to new cache storage
            const bin = idbStorage.get(null);
            if ( typeof bin !== 'object' || bin === null ) { return; }
            const toMigrate = {};
            for ( const key of Object.keys(bin) ) {
                if ( key.startsWith('cache/selfie/') ) { continue; }
                toMigrate[key] = bin[key]; 
            }
            if ( Object.keys(toMigrate).length !== 0 ) {
                await cacheStorage.set(toMigrate);
            }
            return idbStorage.clear();
        },

        error: undefined
    };
})();

// Not all platforms support getBytesInUse
if ( storageLocal.getBytesInUse instanceof Function ) {
    cacheStorage.getBytesInUse = function(...args) {
        return storageLocal.getBytesInUse(...args).catch(reason => {
            ubolog(reason);
        });
    };
}

/*******************************************************************************
 * 
 * Cache API
 * 
 * May not be available/populated in private/incognito mode.
 * 
 * */

const cacheAPI = (( ) => {
    const cacheStoragePromise = new Promise(resolve => {
        if ( globalThis.caches instanceof Object === false ) {
            resolve(null);
        }
        resolve(globalThis.caches.open(STORAGE_NAME).catch(reason => {
            ubolog(reason);
        }));
    });

    const urlPrefix = 'https://ublock0.invalid/';

    const keyToURL = key =>
        `${urlPrefix}${encodeURIComponent(key)}`;

    const urlToKey = url =>
        decodeURIComponent(url.slice(urlPrefix.length));

    const getOne = async key => {
        const cache = await cacheStoragePromise;
        if ( cache === null ) { return; }
        return cache.match(keyToURL(key)).then(response => {
            if ( response instanceof Response === false ) { return; }
            return response.text();
        }).then(text => {
            if ( text === undefined ) { return; }
            return { key, text };
        }).catch(reason => {
            ubolog(reason);
        });
    };

    const getAll = async ( ) => {
        const cache = await cacheStoragePromise;
        if ( cache === null ) { return; }
        return cache.keys().then(requests => {
            const promises = [];
            for ( const request of requests ) {
                promises.push(getOne(urlToKey(request.url)));
            }
            return Promise.all(promises);
        }).then(responses => {
            const bin = {};
            for ( const response of responses ) {
                if ( response === undefined ) { continue; }
                bin[response.key] = response.text;
            }
            return bin;
        }).catch(reason => {
            ubolog(reason);
        });
    };

    const setOne = async (key, text) => {
        if ( text === undefined ) { return removeOne(key); }
        const blob = new Blob([ text ], { type: 'text/plain;charset=utf-8'});
        const cache = await cacheStoragePromise;
        if ( cache === null ) { return; }
        return cache
            .put(keyToURL(key), new Response(blob))
            .catch(reason => {
                ubolog(reason);
            });
    };

    const removeOne = async key => {
        const cache = await cacheStoragePromise;
        if ( cache === null ) { return; }
        return cache.delete(keyToURL(key)).catch(reason => {
            ubolog(reason);
        });
    };

    return {
        async get(arg) {
            const keys = keysFromGetArg(arg);
            if ( keys === undefined ) { return; }
            if ( keys.length === 0 ) {
                return getAll();
            }
            const bin = {};
            const toFetch = keys.slice();
            const hasDefault = typeof arg === 'object' && Array.isArray(arg) === false;
            for ( let i = 0; i < toFetch.length; i++ ) {
                const key = toFetch[i];
                if ( hasDefault && arg[key] !== undefined ) {
                    bin[key] = arg[key];
                }
                toFetch[i] = getOne(key);
            }
            const responses = await Promise.all(toFetch);
            for ( const response of responses ) {
                if ( response instanceof Object === false ) { continue; }
                const { key, text } = response;
                if ( typeof key !== 'string' ) { continue; }
                if ( typeof text !== 'string' ) { continue; }
                bin[key] = text;
            }
            if ( Object.keys(bin).length === 0 ) { return; }
            return bin;
        },

        async keys(regex) {
            const cache = await cacheStoragePromise;
            if ( cache === null ) { return []; }
            return cache.keys().then(requests =>
                requests.map(r => urlToKey(r.url))
                        .filter(k => regex === undefined || regex.test(k))
            ).catch(( ) => []);
        },

        async set(keyvalStore) {
            const keys = Object.keys(keyvalStore);
            if ( keys.length === 0 ) { return; }
            const promises = [];
            for ( const key of keys ) {
                promises.push(setOne(key, keyvalStore[key]));
            }
            return Promise.all(promises);
        },

        async remove(keys) {
            const toRemove = [];
            if ( typeof keys === 'string' ) {
                toRemove.push(removeOne(keys));
            } else if ( Array.isArray(keys) ) {
                for ( const key of keys ) {
                    toRemove.push(removeOne(key));
                }
            }
            return Promise.all(toRemove);
        },

        async clear() {
            return globalThis.caches.delete(STORAGE_NAME).catch(reason => {
                ubolog(reason);
            });
        },
    };
})();

/*******************************************************************************
 * 
 * IndexedDB
 * 
 * */

// Reassign API entries to that of indexedDB-based ones
const idbStorage = async function() {
    let dbPromise;

    const getDb = function() {
        if ( dbPromise !== undefined ) {
            return dbPromise;
        }
        dbPromise = new Promise(resolve => {
            let req;
            try {
                req = indexedDB.open(STORAGE_NAME, 1);
                if ( req.error ) {
                    ubolog(req.error);
                    req = undefined;
                }
            } catch(ex) {
            }
            if ( req === undefined ) {
                return resolve(null);
            }
            req.onupgradeneeded = function(ev) {
                // https://github.com/uBlockOrigin/uBlock-issues/issues/2725
                //   If context Firefox + incognito mode, fall back to
                //   browser.storage.local for cache storage purpose.
                if (
                    vAPI.webextFlavor.soup.has('firefox') &&
                    browser.extension.inIncognitoContext === true
                ) {
                    return req.onerror();
                }
                if ( ev.oldVersion === 1 ) { return; }
                try {
                    const db = ev.target.result;
                    db.createObjectStore(STORAGE_NAME, { keyPath: 'key' });
                } catch(ex) {
                    req.onerror();
                }
            };
            req.onsuccess = function(ev) {
                if ( resolve === undefined ) { return; }
                req = undefined;
                resolve(ev.target.result);
                resolve = undefined;
            };
            req.onerror = req.onblocked = function() {
                if ( resolve === undefined ) { return; }
                resolve(null);
                resolve = undefined;
            };
            vAPI.defer.once(5000).then(( ) => {
                if ( resolve === undefined ) { return; }
                resolve(null);
                resolve = undefined;
            });
        });
        return dbPromise;
    };

    const fromBlob = function(data) {
        if ( data instanceof Blob === false ) {
            return Promise.resolve(data);
        }
        return new Promise(resolve => {
            const blobReader = new FileReader();
            blobReader.onloadend = ev => {
                resolve(new Uint8Array(ev.target.result));
            };
            blobReader.readAsArrayBuffer(data);
        });
    };

    const decompress = function(store, key, data) {
        return lz4Codec.decode(data, fromBlob).then(data => {
            store[key] = data;
        });
    };

    const visitAllFromDb = async function(visitFn) {
        const db = await getDb();
        if ( !db ) { return visitFn(); }
        const transaction = db.transaction(STORAGE_NAME, 'readonly');
        transaction.oncomplete =
        transaction.onerror =
        transaction.onabort = ( ) => visitFn();
        const table = transaction.objectStore(STORAGE_NAME);
        const req = table.openCursor();
        req.onsuccess = function(ev) {
            let cursor = ev.target && ev.target.result;
            if ( !cursor ) { return; }
            let entry = cursor.value;
            visitFn(entry);
            cursor.continue();
        };
    };

    const getAllFromDb = function(callback) {
        if ( typeof callback !== 'function' ) { return; }
        const promises = [];
        const keyvalStore = {};
        visitAllFromDb(entry => {
            if ( entry === undefined ) {
                Promise.all(promises).then(( ) => {
                    callback(keyvalStore);
                });
                return;
            }
            const { key, value } = entry;
            keyvalStore[key] = value;
            if ( entry.value instanceof Blob === false ) { return; }
            promises.push(decompress(keyvalStore, key, value));
        }).catch(reason => {
            console.info(`cacheStorage.getAllFromDb() failed: ${reason}`);
            callback();
        });
    };

    const clearDb = async function(callback) {
        if ( typeof callback !== 'function' ) {
            callback = ()=>{};
        }
        try {
            const db = await getDb();
            if ( !db ) { return callback(); }
            db.close();
            indexedDB.deleteDatabase(STORAGE_NAME);
        }
        catch(reason) {
            callback();
        }
    };

    {
        const db = await getDb();
        if ( !db ) { return; }
    }

    return {
        get: function get(keys) {
            return new Promise(resolve => {
                if ( keys === null ) {
                    return getAllFromDb(bin => resolve(bin));
                }
            });
        },
        clear: function clear() {
            return new Promise(resolve => {
                clearDb(( ) => resolve());
            });
        },
    };
};

/******************************************************************************/

export default cacheStorage;

/******************************************************************************/
