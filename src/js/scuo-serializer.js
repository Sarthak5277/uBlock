/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2024-present Raymond Hill

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

'use strict';

/*******************************************************************************
 * Structured-Cloneable to Unicode-Only SERIALIZER
 * 
 * Purpose:
 * 
 * Serialize/deserialize arbitrary JS data to/from well-formed Unicode strings.
 * 
 * The browser does not expose an API to serialize structured-cloneable types
 * into a single string. JSON.stringify() does not support complex JavaScript
 * objects, and does not support references to composite types. Unless the
 * data to serialize is only JS strings, it is difficult to easily switch
 * from one type of storage to another.
 * 
 * Serializing to a well-formed Unicode string allows to store structured-
 * cloneable data to any storage. Not all storages support storing binary data,
 * but all storages support storing Unicode strings.
 * 
 * Structured-cloneable types:
 * https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm#supported_types
 * 
 * ----------------+------------------+------------------+----------------------
 * Data types      | String           | JSONable         | structured-cloneable
 * ================+============================================================
 * document.cookie | Yes              | No               | No
 * ----------------+------------------+------------------+----------------------
 * localStorage    | Yes              | No               | No
 * ----------------+------------------+------------------+----------------------
 * IndexedDB       | Yes              | Yes              | Yes
 * ----------------+------------------+------------------+----------------------
 * browser.storage | Yes              | Yes              | No
 * ----------------+------------------+------------------+----------------------
 * Cache API       | Yes              | No               | No
 * ----------------+------------------+------------------+----------------------
 * 
 * The above table shows that only JS strings can be persisted natively to all
 * types of storage. The purpose of this library is to convert
 * structure-cloneable data (which is a superset of JSONable data) into a
 * single JS string. The resulting string is meant to be as small as possible.
 * As a result, it is not human-readable, though it contains only printable
 * ASCII characters.
 * 
 * The resulting JS string will not contain characters which require escaping
 * should it be converted to a JSON value. However it may contain characters
 * which require escaping should it be converted to a URI component.
 * 
 * Characteristics:
 * 
 * - Serializes/deserializes data to/from a single well-formed Unicode string
 * - Strings do not require escaping, i.e. they are stored as-is
 * - Supports multiple references to same object
 * - Supports reference cycles
 * - Supports synchronous and asynchronous API
 * - Supports usage of Worker
 * - Optionally supports LZ4 compression
 * 
 * Limits:
 * 
 * - Maximum value for size in uint32. For instance this means an Array, a Set,
 *   a Map, an ArrayBuffer etc. can't have more than 2^32 items.
 * 
 * TODO:
 * 
 * - Harden against unexpected conditions, such as corrupted string during
 *   deserialization.
 * - Evaluate supporting checksum.
 * 
 * */

const VERSION = 1;
const SEPARATORCHAR = ' ';
const SEPARATORCHARCODE = SEPARATORCHAR.charCodeAt(0);
const MAGICPREFIX = `UOSC_${VERSION}${SEPARATORCHAR}`;
const MAGICLZ4PREFIX = `UOSC/lz4_${VERSION}${SEPARATORCHAR}`;
const FAILMARK = Number.MAX_SAFE_INTEGER;
// Avoid characters which require escaping when serialized to JSON:
const SAFECHARS = "&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const NUMSAFECHARS = SAFECHARS.length;
const BITS_PER_SAFECHARS = Math.log2(NUMSAFECHARS);

const { intToChar, intToCharCode, charCodeToInt } = (( ) => {
    const intToChar = [];
    const intToCharCode = [];
    const charCodeToInt = [];
    for ( let i = 0; i < NUMSAFECHARS; i++ ) {
         intToChar[i] = SAFECHARS.charAt(i);
         intToCharCode[i] = SAFECHARS.charCodeAt(i);
         charCodeToInt[i] = 0;
    }
    for ( let i = NUMSAFECHARS; i < 128; i++ ) {
         intToChar[i] = '';
         intToCharCode[i] = 0;
         charCodeToInt[i] = 0;
    }
    for ( let i = 0; i < SAFECHARS.length; i++ ) {
        charCodeToInt[SAFECHARS.charCodeAt(i)] = i;
    }
    return { intToChar, intToCharCode, charCodeToInt };
})();

let iota = 1;
const I_STRING_SMALL      = iota++;
const I_STRING_LARGE      = iota++;
const I_ZERO              = iota++;
const I_INTEGER_SMALL_POS = iota++;
const I_INTEGER_SMALL_NEG = iota++;
const I_INTEGER_LARGE_POS = iota++;
const I_INTEGER_LARGE_NEG = iota++;
const I_BOOL_FALSE        = iota++;
const I_BOOL_TRUE         = iota++;
const I_NULL              = iota++;
const I_UNDEFINED         = iota++;
const I_FLOAT             = iota++;
const I_REGEXP            = iota++;
const I_DATE              = iota++;
const I_REFERENCE         = iota++;
const I_SMALL_OBJECT      = iota++;
const I_LARGE_OBJECT      = iota++;
const I_ARRAY_SMALL       = iota++;
const I_ARRAY_LARGE       = iota++;
const I_SET_SMALL         = iota++;
const I_SET_LARGE         = iota++;
const I_MAP_SMALL         = iota++;
const I_MAP_LARGE         = iota++;
const I_ARRAYBUFFER       = iota++;
const I_INT8ARRAY         = iota++;
const I_UINT8ARRAY        = iota++;
const I_UINT8CLAMPEDARRAY = iota++;
const I_INT16ARRAY        = iota++;
const I_UINT16ARRAY       = iota++;
const I_INT32ARRAY        = iota++;
const I_UINT32ARRAY       = iota++;
const I_FLOAT32ARRAY      = iota++;
const I_FLOAT64ARRAY      = iota++;
const I_DATAVIEW          = iota++;

const C_STRING_SMALL      = intToChar[I_STRING_SMALL];
const C_STRING_LARGE      = intToChar[I_STRING_LARGE];
const C_ZERO              = intToChar[I_ZERO];
const C_INTEGER_SMALL_POS = intToChar[I_INTEGER_SMALL_POS];
const C_INTEGER_SMALL_NEG = intToChar[I_INTEGER_SMALL_NEG];
const C_INTEGER_LARGE_POS = intToChar[I_INTEGER_LARGE_POS];
const C_INTEGER_LARGE_NEG = intToChar[I_INTEGER_LARGE_NEG];
const C_BOOL_FALSE        = intToChar[I_BOOL_FALSE];
const C_BOOL_TRUE         = intToChar[I_BOOL_TRUE];
const C_NULL              = intToChar[I_NULL];
const C_UNDEFINED         = intToChar[I_UNDEFINED];
const C_FLOAT             = intToChar[I_FLOAT];
const C_REGEXP            = intToChar[I_REGEXP];
const C_DATE              = intToChar[I_DATE];
const C_REFERENCE         = intToChar[I_REFERENCE];
const C_SMALL_OBJECT      = intToChar[I_SMALL_OBJECT];
const C_LARGE_OBJECT      = intToChar[I_LARGE_OBJECT];
const C_ARRAY_SMALL       = intToChar[I_ARRAY_SMALL];
const C_ARRAY_LARGE       = intToChar[I_ARRAY_LARGE];
const C_SET_SMALL         = intToChar[I_SET_SMALL];
const C_SET_LARGE         = intToChar[I_SET_LARGE];
const C_MAP_SMALL         = intToChar[I_MAP_SMALL];
const C_MAP_LARGE         = intToChar[I_MAP_LARGE];
const C_ARRAYBUFFER       = intToChar[I_ARRAYBUFFER];
const C_INT8ARRAY         = intToChar[I_INT8ARRAY];
const C_UINT8ARRAY        = intToChar[I_UINT8ARRAY];
const C_UINT8CLAMPEDARRAY = intToChar[I_UINT8CLAMPEDARRAY];
const C_INT16ARRAY        = intToChar[I_INT16ARRAY];
const C_UINT16ARRAY       = intToChar[I_UINT16ARRAY];
const C_INT32ARRAY        = intToChar[I_INT32ARRAY];
const C_UINT32ARRAY       = intToChar[I_UINT32ARRAY];
const C_FLOAT32ARRAY      = intToChar[I_FLOAT32ARRAY];
const C_FLOAT64ARRAY      = intToChar[I_FLOAT64ARRAY];
const C_DATAVIEW          = intToChar[I_DATAVIEW];

// Just reuse already defined constants, we just need distinct values
const I_STRING            = I_STRING_SMALL;
const I_NUMBER            = I_FLOAT;
const I_BOOL              = I_BOOL_FALSE;
const I_OBJECT            = I_SMALL_OBJECT;
const I_ARRAY             = I_ARRAY_SMALL;
const I_SET               = I_SET_SMALL;
const I_MAP               = I_MAP_SMALL;

const typeToSerializedInt = {
    'string': I_STRING,
    'number': I_NUMBER,
    'boolean': I_BOOL,
    'object': I_OBJECT,
};

const xtypeToSerializedInt = {
    '[object RegExp]': I_REGEXP,
    '[object Date]': I_DATE,
    '[object Array]': I_ARRAY,
    '[object Set]': I_SET,
    '[object Map]': I_MAP,
    '[object ArrayBuffer]': I_ARRAYBUFFER,
    '[object Int8Array]': I_INT8ARRAY,
    '[object Uint8Array]': I_UINT8ARRAY,
    '[object Uint8ClampedArray]': I_UINT8CLAMPEDARRAY,
    '[object Int16Array]': I_INT16ARRAY,
    '[object Uint16Array]': I_UINT16ARRAY,
    '[object Int32Array]': I_INT32ARRAY,
    '[object Uint32Array]': I_UINT32ARRAY,
    '[object Float32Array]': I_FLOAT32ARRAY,
    '[object Float64Array]': I_FLOAT64ARRAY,
    '[object DataView]': I_DATAVIEW,
};

const typeToSerializedChar = {
    '[object Int8Array]': C_INT8ARRAY,
    '[object Uint8Array]': C_UINT8ARRAY,
    '[object Uint8ClampedArray]': C_UINT8CLAMPEDARRAY,
    '[object Int16Array]': C_INT16ARRAY,
    '[object Uint16Array]': C_UINT16ARRAY,
    '[object Int32Array]': C_INT32ARRAY,
    '[object Uint32Array]': C_UINT32ARRAY,
    '[object Float32Array]': C_FLOAT32ARRAY,
    '[object Float64Array]': C_FLOAT64ARRAY,
};

const toArrayBufferViewConstructor = {
    [`${I_INT8ARRAY}`]: Int8Array,
    [`${I_UINT8ARRAY}`]: Uint8Array,
    [`${I_UINT8CLAMPEDARRAY}`]: Uint8ClampedArray,
    [`${I_INT16ARRAY}`]: Int16Array,
    [`${I_UINT16ARRAY}`]: Uint16Array,
    [`${I_INT32ARRAY}`]: Int32Array,
    [`${I_UINT32ARRAY}`]: Uint32Array,
    [`${I_FLOAT32ARRAY}`]: Float32Array,
    [`${I_FLOAT64ARRAY}`]: Float64Array,
    [`${I_DATAVIEW}`]: DataView,
};

/******************************************************************************/

const isInteger = Number.isInteger;

const writeRefs = new Map();
const writeBuffer = [];

const readRefs = new Map();
let readStr = '';
let readPtr = 0;
let readEnd = 0;

let refCounter = 1;

/*******************************************************************************
 * 
 * A "size" is always uint32-compatible value. The serialized value has
 * always at least one digit, and is always followed by a separator.
 * 
 * */

const serializeSize = i => {
    let r = 0, s = '';
    for (;;) {
        r = i % NUMSAFECHARS;
        s += intToChar[r];
        i -= r;
        if ( i === 0 ) { break; }
        i /= NUMSAFECHARS;
    }
    return s + SEPARATORCHAR;
};

const deserializeSize = ( ) => {
    let c = readStr.charCodeAt(readPtr++);
    let out = charCodeToInt[c];
    let m = NUMSAFECHARS;
    while ( (c = readStr.charCodeAt(readPtr++)) !== SEPARATORCHARCODE ) {
        out += charCodeToInt[c] * m;
        m *= NUMSAFECHARS;
    }
    return out;
};

/*******************************************************************************
 * 
 * Methods specific to ArrayBuffer objects to serialize optimally according to
 * the content of the buffer.
 * 
 * Number of output bytes per input int32 (4-byte) value:
 * [v === zero]: 1 byte
 * [-NUMSAFECHARS < v < NUMSAFECHARS]: 1 byte + 1 digit
 * [v <= -NUMSAFECHARS]: 1 byte + number of digits + 1 byte (separator)
 * [v >=  NUMSAFECHARS]: 1 byte + number of digits + 1 byte (separator)
 * 
 * */

const analyzeArrayBuffer = arrbuf => {
    const byteLength = arrbuf.byteLength;
    const int32len = byteLength >>> 2;
    const int32arr = new Int32Array(arrbuf, 0, int32len);
    let notzeroCount = 0;
    for ( let i = int32len-1; i >= 0; i-- ) {
        if ( int32arr[i] === 0 ) { continue; }
        notzeroCount = i + 1;
        break;
    }
    const contentByteLength = notzeroCount + 1 <= int32len ? notzeroCount << 2 : byteLength;
    const contentInt32Len = contentByteLength >>> 2;
    const contentInt32Rem = contentByteLength & 0b11;
    const denseSize = contentInt32Len * 5 + (contentInt32Rem ? contentInt32Rem + 1 : 0);
    let sparseSize = 0;
    for ( let i = 0, n = contentInt32Len; i < n; i++ ) {
        const v = int32arr[i];
        if ( v === 0 ) {
            sparseSize += 1;
        } else {
            sparseSize += 2;
            if ( v >= NUMSAFECHARS ) {
                sparseSize += (Math.log2( v) / BITS_PER_SAFECHARS | 0) + 1;
            } else if ( v <= -NUMSAFECHARS ) {
                sparseSize += (Math.log2(-v) / BITS_PER_SAFECHARS | 0) + 1;
            }
        }
        if ( sparseSize > denseSize ) {
            return { contentByteLength, dense: true };
        }
    }
    return { contentByteLength, dense: false };
};

const denseArrayBufferToStr = (arrbuf, end) => {
    const m = end % 4;
    const n = end - m;
    const uin32len = n >>> 2;
    const uint32arr = new Uint32Array(arrbuf, 0, uin32len);
    const outlen = uin32len * 5 + (m ? m + 1 : 0);
    const output = new Uint8Array(outlen);
    let j = 0, v = 0;
    for ( let i = 0; i < uin32len; i++ ) {
        v = uint32arr[i];
        output[j+0] = intToCharCode[v % NUMSAFECHARS];
        v = v / NUMSAFECHARS | 0;
        output[j+1] = intToCharCode[v % NUMSAFECHARS];
        v = v / NUMSAFECHARS | 0;
        output[j+2] = intToCharCode[v % NUMSAFECHARS];
        v = v / NUMSAFECHARS | 0;
        output[j+3] = intToCharCode[v % NUMSAFECHARS];
        v = v / NUMSAFECHARS | 0;
        output[j+4] = intToCharCode[v];
        j += 5;
    }
    if ( m !== 0 ) {
        const uint8arr = new Uint8Array(arrbuf, n);
        v = uint8arr[0];
        if ( m > 1 ) {
            v += uint8arr[1] << 8;
            if ( m > 2 ) {
                v += uint8arr[2] << 16;
            }
        }
        output[j+0] = intToCharCode[v % NUMSAFECHARS];
        v = v / NUMSAFECHARS | 0;
        output[j+1] = intToCharCode[v % NUMSAFECHARS];
        if ( m > 1 ) {
            v = v / NUMSAFECHARS | 0;
            output[j+2] = intToCharCode[v % NUMSAFECHARS];
            if ( m > 2 ) {
                v = v / NUMSAFECHARS | 0;
                output[j+3] = intToCharCode[v % NUMSAFECHARS];
            }
        }
    }
    const textDecoder = new TextDecoder();
    return textDecoder.decode(output);
};

const BASE88_POW0 = Math.pow(NUMSAFECHARS, 0);
const BASE88_POW1 = Math.pow(NUMSAFECHARS, 1);
const BASE88_POW2 = Math.pow(NUMSAFECHARS, 2);
const BASE88_POW3 = Math.pow(NUMSAFECHARS, 3);
const BASE88_POW4 = Math.pow(NUMSAFECHARS, 4);

const denseArrayBufferFromStr = (base88str, arrbuf) => {
    const end = base88str.length;
    const m = end % 5;
    const n = end - m;
    const uin32len = n / 5 * 4 >>> 2;
    const uint32arr = new Uint32Array(arrbuf, 0, uin32len);
    let j = 0, v = 0;
    for ( let i = 0; i < n; i += 5 ) {
        v  = BASE88_POW0 * charCodeToInt[base88str.charCodeAt(i+0)];
        v += BASE88_POW1 * charCodeToInt[base88str.charCodeAt(i+1)];
        v += BASE88_POW2 * charCodeToInt[base88str.charCodeAt(i+2)];
        v += BASE88_POW3 * charCodeToInt[base88str.charCodeAt(i+3)];
        v += BASE88_POW4 * charCodeToInt[base88str.charCodeAt(i+4)];
        uint32arr[j++] = v;
    }
    if ( m === 0 ) { return; }
    v  = BASE88_POW0 * charCodeToInt[base88str.charCodeAt(n+0)]
       + BASE88_POW1 * charCodeToInt[base88str.charCodeAt(n+1)];
    if ( m > 2 ) {
        v += BASE88_POW2 * charCodeToInt[base88str.charCodeAt(n+2)];
        if ( m > 3 ) {
            v += BASE88_POW3 * charCodeToInt[base88str.charCodeAt(n+3)];
        }
    }
    const uint8arr = new Uint8Array(arrbuf, j << 2);
    uint8arr[0] = v & 255;
    if ( v !== 0 ) {
        v >>>= 8;
        uint8arr[1] = v & 255;
        if ( v !== 0 ) {
            v >>>= 8;
            uint8arr[2] = v & 255;
        }
    }
};

const sparseArrayBufferToStr = (arrbuf, end) => {
    const parts = [ serializeSize(end) ];
    const int32len = end >>> 2;
    const int32arr = new Int32Array(arrbuf, 0, int32len);
    for ( let i = 0; i < int32len; i++ ) {
        const n = int32arr[i];
        if ( n === 0 ) {
            parts.push(C_ZERO);
        } else if ( n >= NUMSAFECHARS ) {
            parts.push(C_INTEGER_LARGE_POS + serializeSize(n));
        } else if ( n > 0 ) {
            parts.push(C_INTEGER_SMALL_POS + intToChar[n]);
        } else if ( n > -NUMSAFECHARS ) {
            parts.push(C_INTEGER_SMALL_NEG + intToChar[-n]);
        } else {
            parts.push(C_INTEGER_LARGE_NEG + serializeSize(-n));
        }
    }
    const int8len = end & 0b11;
    if ( int8len !== 0 ) {
        const int8arr = new Int8Array(arrbuf, end - int8len, int8len);
        for ( let i = 0; i < int8len; i++ ) {
            const n = int8arr[i];
            if ( n === 0 ) {
                parts.push(C_ZERO);
            } else if ( n >= NUMSAFECHARS ) {
                parts.push(C_INTEGER_LARGE_POS + serializeSize(n));
            } else if ( n > 0 ) {
                parts.push(C_INTEGER_SMALL_POS + intToChar[n]);
            } else if ( n > -NUMSAFECHARS ) {
                parts.push(C_INTEGER_SMALL_NEG + intToChar[-n]);
            } else {
                parts.push(C_INTEGER_LARGE_NEG + serializeSize(-n));
            }
        }
    }
    return parts.join('');
};

const sparseArrayBufferFromStr = (str, arrbuf) => {
    const save = { readStr, readPtr };
    readStr = str; readPtr = 0;
    const end = deserializeSize();
    const int32len = end >>> 2;
    const int32arr = new Int32Array(arrbuf, 0, int32len);
    for ( let i = 0; i < int32len; i++ ) {
        const type = charCodeToInt[readStr.charCodeAt(readPtr++)];
        switch ( type ) {
            case I_ZERO:
                break;
            case I_INTEGER_SMALL_POS:
                int32arr[i] = charCodeToInt[readStr.charCodeAt(readPtr++)];
                break;
            case I_INTEGER_SMALL_NEG:
                int32arr[i] = -charCodeToInt[readStr.charCodeAt(readPtr++)];
                break;
            case I_INTEGER_LARGE_POS:
                int32arr[i] = deserializeSize();
                break;
            case I_INTEGER_LARGE_NEG:
                int32arr[i] = -deserializeSize();
                break;
        }
    }
    const int8len = end & 0b11;
    if ( int8len !== 0 ) {
        const int8arr = new Int8Array(arrbuf, end - int8len, int8len);
        for ( let i = 0; i < int8len; i++ ) {
            const type = charCodeToInt[readStr.charCodeAt(readPtr++)];
            switch ( type ) {
                case I_ZERO:
                    break;
                case I_INTEGER_SMALL_POS:
                    int8arr[i] = charCodeToInt[readStr.charCodeAt(readPtr++)];
                    break;
                case I_INTEGER_SMALL_NEG:
                    int8arr[i] = -charCodeToInt[readStr.charCodeAt(readPtr++)];
                    break;
                case I_INTEGER_LARGE_POS:
                    int8arr[i] = deserializeSize();
                    break;
                case I_INTEGER_LARGE_NEG:
                    int8arr[i] = -deserializeSize();
                    break;
            }
        }
    }
    ({ readStr, readPtr } = save);
};

/******************************************************************************/

const _serialize = data => {
    // Primitive types
    if ( data === 0 ) {
        writeBuffer.push(C_ZERO);
        return;
    }
    if ( data === null ) {
        writeBuffer.push(C_NULL);
        return;
    }
    if ( data === undefined ) {
        writeBuffer.push(C_UNDEFINED);
        return;
    }
    // Type name
    switch ( typeToSerializedInt[typeof data] ) {
        case I_STRING: {
            const length = data.length;
            if ( length < NUMSAFECHARS ) {
                writeBuffer.push(C_STRING_SMALL + intToChar[length], data);
            } else {
                writeBuffer.push(C_STRING_LARGE + serializeSize(length), data);
            }
            return;
        }
        case I_NUMBER:
            if ( isInteger(data) ) {
                if ( data >= NUMSAFECHARS ) {
                    writeBuffer.push(C_INTEGER_LARGE_POS + serializeSize(data));
                } else if ( data > 0 ) {
                    writeBuffer.push(C_INTEGER_SMALL_POS + intToChar[data]);
                } else if ( data > -NUMSAFECHARS ) {
                    writeBuffer.push(C_INTEGER_SMALL_NEG + intToChar[-data]);
                } else {
                    writeBuffer.push(C_INTEGER_LARGE_NEG + serializeSize(-data));
                }
            } else {
                const s = `${data}`;
                writeBuffer.push(C_FLOAT + serializeSize(s.length), s);
            }
            return;
        case I_BOOL:
            writeBuffer.push(data ? C_BOOL_TRUE : C_BOOL_FALSE);
            return;
        case I_OBJECT:
            break;
        default:
            return;
    }
    const xtypeName = Object.prototype.toString.call(data);
    const xtypeInt = xtypeToSerializedInt[xtypeName];
    if ( xtypeInt === I_REGEXP ) {
        writeBuffer.push(C_REGEXP);
        _serialize(data.source);
        _serialize(data.flags);
        return;
    }
    if ( xtypeInt === I_DATE ) {
        writeBuffer.push(C_DATE + _serialize(data.getTime()));
        return;
    }
    // Reference to composite types
    const ref = writeRefs.get(data);
    if ( ref !== undefined ) {
        writeBuffer.push(C_REFERENCE + serializeSize(ref));
        return;
    }
    // Remember reference
    writeRefs.set(data, refCounter++);
    // Extended type name
    switch ( xtypeInt ) {
        case I_ARRAY: {
            const size = data.length;
            if ( size < NUMSAFECHARS ) {
                writeBuffer.push(C_ARRAY_SMALL + intToChar[size]);
            } else {
                writeBuffer.push(C_ARRAY_LARGE + serializeSize(size));
            }
            for ( const v of data ) {
                _serialize(v);
            }
            return;
        }
        case I_SET: {
            const size = data.size;
            if ( size < NUMSAFECHARS ) {
                writeBuffer.push(C_SET_SMALL + intToChar[size]);
            } else {
                writeBuffer.push(C_SET_LARGE + serializeSize(size));
            }
            for ( const v of data ) {
                _serialize(v);
            }
            return;
        }
        case I_MAP: {
            const size = data.size;
            if ( size < NUMSAFECHARS ) {
                writeBuffer.push(C_MAP_SMALL + intToChar[size]);
            } else {
                writeBuffer.push(C_MAP_LARGE + serializeSize(size));
            }
            for ( const [ k, v ] of data ) {
                _serialize(k);
                _serialize(v);
            }
            return;
        }
        case I_ARRAYBUFFER: {
            const byteLength = data.byteLength;
            writeBuffer.push(C_ARRAYBUFFER + serializeSize(byteLength));
            _serialize(data.maxByteLength);
            const arrbuffDetails = analyzeArrayBuffer(data);
            _serialize(arrbuffDetails.dense);
            const str = arrbuffDetails.dense
                ? denseArrayBufferToStr(data, arrbuffDetails.contentByteLength)
                : sparseArrayBufferToStr(data, arrbuffDetails.contentByteLength);
            _serialize(str);
            console.log(`arrbuf size=${byteLength} content size=${arrbuffDetails.contentByteLength} dense=${arrbuffDetails.dense} serialized size=${str.length}`);
            return;
        }
        case I_INT8ARRAY:
        case I_UINT8ARRAY:
        case I_UINT8CLAMPEDARRAY:
        case I_INT16ARRAY:
        case I_UINT16ARRAY:
        case I_INT32ARRAY:
        case I_UINT32ARRAY:
        case I_FLOAT32ARRAY:
        case I_FLOAT64ARRAY:
            writeBuffer.push(
                typeToSerializedChar[xtypeName],
                serializeSize(data.byteOffset),
                serializeSize(data.length)
            );
            _serialize(data.buffer);
            return;
        case I_DATAVIEW:
            writeBuffer.push(C_DATAVIEW, serializeSize(data.byteOffset), serializeSize(data.byteLength));
            _serialize(data.buffer);
            return;
        default: {
            const keys = Object.keys(data);
            const size = keys.length;
            if ( size < NUMSAFECHARS ) {
                writeBuffer.push(C_SMALL_OBJECT + intToChar[size]);
            } else {
                writeBuffer.push(C_LARGE_OBJECT + serializeSize(size));
            }
            for ( const key of keys ) {
                _serialize(key);
                _serialize(data[key]);
            }
            break;
        }
    }
};

/******************************************************************************/

const _deserialize = ( ) => {
    if ( readPtr >= readEnd ) { return; }
    const type = charCodeToInt[readStr.charCodeAt(readPtr++)];
    switch ( type ) {
        // Primitive types
        case I_STRING_SMALL:
        case I_STRING_LARGE: {
            const size = type === I_STRING_SMALL
                ? charCodeToInt[readStr.charCodeAt(readPtr++)]
                : deserializeSize();
            const beg = readPtr;
            readPtr += size;
            return readStr.slice(beg, readPtr);
        }
        case I_ZERO:
            return 0;
        case I_INTEGER_SMALL_POS:
            return charCodeToInt[readStr.charCodeAt(readPtr++)];
        case I_INTEGER_SMALL_NEG:
            return -charCodeToInt[readStr.charCodeAt(readPtr++)];
        case I_INTEGER_LARGE_POS:
            return deserializeSize();
        case I_INTEGER_LARGE_NEG:
            return -deserializeSize();
        case I_BOOL_FALSE:
            return false;
        case I_BOOL_TRUE:
            return true;
        case I_NULL:
            return null;
        case I_UNDEFINED:
            return;
        case I_FLOAT: {
            const size = deserializeSize();
            const beg = readPtr;
            readPtr += size;
            return parseFloat(readStr.slice(beg, readPtr));
        }
        case I_REGEXP: {
            const source = _deserialize();
            const flags = _deserialize();
            return new RegExp(source, flags);
        }
        case I_DATE: {
            const time = _deserialize();
            return new Date(time);
        }
        case I_REFERENCE: {
            const ref = deserializeSize();
            return readRefs.get(ref);
        }
        case I_SMALL_OBJECT:
        case I_LARGE_OBJECT: {
            const out = {};
            let size = type === I_SMALL_OBJECT
                ? charCodeToInt[readStr.charCodeAt(readPtr++)]
                : deserializeSize();
            while ( size-- ) {
                const k = _deserialize();
                const v = _deserialize();
                out[k] = v;
            }
            readRefs.set(refCounter++, out);
            return out;
        }
        case I_ARRAY_SMALL:
        case I_ARRAY_LARGE: {
            const out = [];
            let size = type === I_ARRAY_SMALL
                ? charCodeToInt[readStr.charCodeAt(readPtr++)]
                : deserializeSize();
            while ( size-- ) {
                out.push(_deserialize());
            }
            readRefs.set(refCounter++, out);
            return out;
        }
        case I_SET_SMALL:
        case I_SET_LARGE: {
            const out = new Set();
            let size = type === I_SET_SMALL
                ? charCodeToInt[readStr.charCodeAt(readPtr++)]
                : deserializeSize();
            while ( size-- ) {
                out.add(_deserialize());
            }
            readRefs.set(refCounter++, out);
            return out;
        }
        case I_MAP_SMALL:
        case I_MAP_LARGE: {
            const out = new Map();
            let size = type === I_MAP_SMALL
                ? charCodeToInt[readStr.charCodeAt(readPtr++)]
                : deserializeSize();
            while ( size-- ) {
                const k = _deserialize();
                const v = _deserialize();
                out.set(k, v);
            }
            readRefs.set(refCounter++, out);
            return out;
        }
        case I_ARRAYBUFFER: {
            const byteLength = deserializeSize();
            const maxByteLength = _deserialize();
            let options;
            if ( maxByteLength !== 0 && maxByteLength !== byteLength ) {
                options = { maxByteLength };
            }
            const arrbuf = new ArrayBuffer(byteLength, options);
            const dense = _deserialize();
            const str = _deserialize();
            if ( dense ) {
                denseArrayBufferFromStr(str, arrbuf);
            } else {
                sparseArrayBufferFromStr(str, arrbuf);
            }
            readRefs.set(refCounter++, arrbuf);
            return arrbuf;
        }
        case I_INT8ARRAY:
        case I_UINT8ARRAY:
        case I_UINT8CLAMPEDARRAY:
        case I_INT16ARRAY:
        case I_UINT16ARRAY:
        case I_INT32ARRAY:
        case I_UINT32ARRAY:
        case I_FLOAT32ARRAY:
        case I_FLOAT64ARRAY:
        case I_DATAVIEW: {
            const byteOffset = deserializeSize();
            const length = deserializeSize();
            const arrayBuffer = _deserialize();
            const ctor = toArrayBufferViewConstructor[`${type}`];
            const out = new ctor(arrayBuffer, byteOffset, length);
            readRefs.set(refCounter++, out);
            return out;
        }
        default:
            break;
    }
    readPtr = FAILMARK;
};

/*******************************************************************************
 * 
 * LZ4 block compression.decompression
 * 
 * Imported from:
 * https://github.com/gorhill/lz4-wasm/blob/master/dist/lz4-block-codec-js.js
 * 
 * Customized to avoid external dependencies as I entertain the idea of
 * spinning off the serializer as a standalone utility for all to use.
 * 
 * */
 
class LZ4BlockJS {
    constructor() {
        this.hashTable = undefined;
        this.outputBuffer = undefined;
    }
    reset() {
        this.hashTable = undefined;
        this.outputBuffer = undefined;
    }
    growOutputBuffer(size) {
        if ( this.outputBuffer !== undefined ) {
            if ( this.outputBuffer.byteLength >= size ) { return; }
        }
        this.outputBuffer = new ArrayBuffer(size + 0xFFFF & 0x7FFF0000);
    }
    encodeBound(size) {
        return size > 0x7E000000 ? 0 : size + (size / 255 | 0) + 16;
    }
    encodeBlock(iBuf, oOffset) {
        const iLen = iBuf.byteLength;
        if ( iLen >= 0x7E000000 ) { throw new RangeError(); }
        // "The last match must start at least 12 bytes before end of block"
        const lastMatchPos = iLen - 12;
        // "The last 5 bytes are always literals"
        const lastLiteralPos = iLen - 5;
        if ( this.hashTable === undefined ) {
            this.hashTable = new Int32Array(65536);
        }
        this.hashTable.fill(-65536);
        if ( iBuf instanceof ArrayBuffer ) {
            iBuf = new Uint8Array(iBuf);
        }
        const oLen = oOffset + this.encodeBound(iLen);
        this.growOutputBuffer(oLen);
        const oBuf = new Uint8Array(this.outputBuffer, 0, oLen);
        let iPos = 0;
        let oPos = oOffset;
        let anchorPos = 0;
        // sequence-finding loop
        for (;;) {
            let refPos;
            let mOffset;
            let sequence = iBuf[iPos] << 8 | iBuf[iPos+1] << 16 | iBuf[iPos+2] << 24;
            // match-finding loop
            while ( iPos <= lastMatchPos ) {
                sequence = sequence >>> 8 | iBuf[iPos+3] << 24;
                const hash = (sequence * 0x9E37 & 0xFFFF) + (sequence * 0x79B1 >>> 16) & 0xFFFF;
                refPos = this.hashTable[hash];
                this.hashTable[hash] = iPos;
                mOffset = iPos - refPos;
                if (
                    mOffset < 65536 &&
                    iBuf[refPos+0] === ((sequence       ) & 0xFF) &&
                    iBuf[refPos+1] === ((sequence >>>  8) & 0xFF) &&
                    iBuf[refPos+2] === ((sequence >>> 16) & 0xFF) &&
                    iBuf[refPos+3] === ((sequence >>> 24) & 0xFF)
                ) {
                    break;
                }
                iPos += 1;
            }
            // no match found
            if ( iPos > lastMatchPos ) { break; }
            // match found
            let lLen = iPos - anchorPos;
            let mLen = iPos;
            iPos += 4; refPos += 4;
            while ( iPos < lastLiteralPos && iBuf[iPos] === iBuf[refPos] ) {
                iPos += 1; refPos += 1;
            }
            mLen = iPos - mLen;
            const token = mLen < 19 ? mLen - 4 : 15;
            // write token, length of literals if needed
            if ( lLen >= 15 ) {
                oBuf[oPos++] = 0xF0 | token;
                let l = lLen - 15;
                while ( l >= 255 ) {
                    oBuf[oPos++] = 255;
                    l -= 255;
                }
                oBuf[oPos++] = l;
            } else {
                oBuf[oPos++] = (lLen << 4) | token;
            }
            // write literals
            while ( lLen-- ) {
                oBuf[oPos++] = iBuf[anchorPos++];
            }
            if ( mLen === 0 ) { break; }
            // write offset of match
            oBuf[oPos+0] = mOffset;
            oBuf[oPos+1] = mOffset >>> 8;
            oPos += 2;
            // write length of match if needed
            if ( mLen >= 19 ) {
                let l = mLen - 19;
                while ( l >= 255 ) {
                    oBuf[oPos++] = 255;
                    l -= 255;
                }
                oBuf[oPos++] = l;
            }
            anchorPos = iPos;
        }
        // last sequence is literals only
        let lLen = iLen - anchorPos;
        if ( lLen >= 15 ) {
            oBuf[oPos++] = 0xF0;
            let l = lLen - 15;
            while ( l >= 255 ) {
                oBuf[oPos++] = 255;
                l -= 255;
            }
            oBuf[oPos++] = l;
        } else {
            oBuf[oPos++] = lLen << 4;
        }
        while ( lLen-- ) {
            oBuf[oPos++] = iBuf[anchorPos++];
        }
        return new Uint8Array(oBuf.buffer, 0, oPos);
    }
    decodeBlock(iBuf, iOffset, oLen) {
        const iLen = iBuf.byteLength;
        this.growOutputBuffer(oLen);
        const oBuf = new Uint8Array(this.outputBuffer, 0, oLen);
        let iPos = iOffset, oPos = 0;
        while ( iPos < iLen ) {
            const token = iBuf[iPos++];
            // literals
            let clen = token >>> 4;
            // length of literals
            if ( clen !== 0 ) {
                if ( clen === 15 ) {
                    let l;
                    for (;;) {
                        l = iBuf[iPos++];
                        if ( l !== 255 ) { break; }
                        clen += 255;
                    }
                    clen += l;
                }
                // copy literals
                const end = iPos + clen;
                while ( iPos < end ) {
                    oBuf[oPos++] = iBuf[iPos++];
                }
                if ( iPos === iLen ) { break; }
            }
            // match
            const mOffset = iBuf[iPos+0] | (iBuf[iPos+1] << 8);
            if ( mOffset === 0 || mOffset > oPos ) { return; }
            iPos += 2;
            // length of match
            clen = (token & 0x0F) + 4;
            if ( clen === 19 ) {
                let l;
                for (;;) {
                    l = iBuf[iPos++];
                    if ( l !== 255 ) { break; }
                    clen += 255;
                }
                clen += l;
            }
            // copy match
            const end = oPos + clen;
            let mPos = oPos - mOffset;
            while ( oPos < end ) {
                oBuf[oPos++] = oBuf[mPos++];
            }
        }
        return oBuf;
    }
    encode(input, outputOffset) {
        if ( input instanceof ArrayBuffer ) {
            input = new Uint8Array(input);
        } else if ( input instanceof Uint8Array === false ) {
            throw new TypeError();
        }
        return this.encodeBlock(input, outputOffset);
    }
    decode(input, inputOffset, outputSize) {
        if ( input instanceof ArrayBuffer ) {
            input = new Uint8Array(input);
        } else if ( input instanceof Uint8Array === false ) {
            throw new TypeError();
        }
        return this.decodeBlock(input, inputOffset, outputSize);
    }
}

/*******************************************************************************
 * 
 * Synchronous APIs
 * 
 * */

export const serialize = (data, options = {}) => {
    refCounter = 1;
    _serialize(data);
    writeBuffer.unshift(MAGICPREFIX);
    const s = writeBuffer.join('');
    writeRefs.clear();
    writeBuffer.length = 0;
    if ( options.compress !== true ) { return s; }
    const lz4Util = new LZ4BlockJS();
    const encoder = new TextEncoder();
    const uint8ArrayBefore = encoder.encode(s);
    const uint8ArrayAfter = lz4Util.encode(uint8ArrayBefore, 0);
    const lz4 = {
        size: uint8ArrayBefore.length,
        data: new Uint8Array(uint8ArrayAfter),
    };
    refCounter = 1;
    _serialize(lz4);
    writeBuffer.unshift(MAGICLZ4PREFIX);
    const t = writeBuffer.join('');
    writeRefs.clear();
    writeBuffer.length = 0;
    const ratio = t.length / s.length;
    return ratio <= 0.85 ? t : s;
};

export const deserialize = s => {
    if ( s.startsWith(MAGICLZ4PREFIX) ) {
        refCounter = 1;
        readStr = s;
        readEnd = s.length;
        readPtr = MAGICLZ4PREFIX.length;
        const lz4 = _deserialize();
        readRefs.clear();
        readStr = '';
        const lz4Util = new LZ4BlockJS();
        const uint8ArrayAfter = lz4Util.decode(lz4.data, 0, lz4.size);
        const decoder = new TextDecoder();
        s = decoder.decode(new Uint8Array(uint8ArrayAfter));
    }
    if ( s.startsWith(MAGICPREFIX) === false ) { return; }
    refCounter = 1;
    readStr = s;
    readEnd = s.length;
    readPtr = MAGICPREFIX.length;
    const data = _deserialize();
    readRefs.clear();
    readStr = '';
    if ( readPtr === FAILMARK ) { return; }
    return data;
};

export const canDeserialize = s =>
    typeof s === 'string' &&
        (s.startsWith(MAGICLZ4PREFIX) || s.startsWith(MAGICPREFIX));

/*******************************************************************************
 * 
 * Configuration
 * 
 * */

const defaultConfig = {
    maxThreadCount: 2,
    threadTTL: 5000,
};

const validateConfig = {
    maxThreadCount: val => val >= 1,
    threadTTL: val => val >= 0,
};

const currentConfig = Object.assign({}, defaultConfig);

export const getConfig = ( ) => Object.assign({}, currentConfig);

export const setConfig = config => {
    for ( const key in Object.keys(config) ) {
        if ( defaultConfig.hasOwnProperty(key) === false ) { continue; }
        const val = config[key];
        if ( typeof val !== typeof defaultConfig[key] ) { continue; }
        if ( (validateConfig[key])(val) === false ) { continue; }
        currentConfig[key] = val;
    }
};

/*******************************************************************************
 * 
 * Asynchronous APIs
 * 
 * Being asynchronous allows to support workers and future features such as
 * checksums.
 * 
 * */

class Thread {
    constructor(gcer) {
        this.jobs = new Map();
        this.jobIdGenerator = 1;
        this.workerAccessTime = 0;
        this.workerTimer = undefined;
        this.gcer = gcer;
        this.workerPromise = new Promise(resolve => {
            let worker = null;
            try {
                worker = new Worker('js/scuo-serializer.js', { type: 'module' });
                worker.onmessage = ev => {
                    const msg = ev.data;
                    if ( msg instanceof Object === false ) { return; }
                    if ( msg.what === 'ready!' ) {
                        worker.onmessage = ev => { this.onmessage(ev); };
                        worker.onerror = null;
                        resolve(worker);
                    }
                };
                worker.onerror = ( ) => {
                    worker.onmessage = worker.onerror = null;
                    resolve(null);
                };
                worker.postMessage({ what: 'ready?', config: currentConfig });
            } catch(ex) {
                console.info(ex);
                worker.onmessage = worker.onerror = null;
                resolve(null);
            }
        });
    }

    countdownWorker() {
        if ( this.workerTimer !== undefined ) { return; }
        this.workerTimer = setTimeout(async ( ) => {
            this.workerTimer = undefined;
            if ( this.jobs.size !== 0 ) { return; }
            const idleTime = Date.now() - this.workerAccessTime;
            if ( idleTime < currentConfig.threadTTL ) {
                return this.countdownWorker();
            }
            const worker = await this.workerPromise;
            if ( this.jobs.size !== 0 ) { return; }
            this.gcer(this);
            if ( worker === null ) { return; }
            worker.onmessage = worker.onerror = null;
            worker.terminate();
        }, currentConfig.threadTTL);
    }

    onmessage(ev) {
        const job = ev.data;
        const resolve = this.jobs.get(job.id);
        if ( resolve === undefined ) { return; }
        this.jobs.delete(job.id);
        resolve(job.result);
        if ( this.jobs.size !== 0 ) { return; }
        this.countdownWorker();
    }

    async serialize(data, options) {
        this.workerAccessTime = Date.now();
        const worker = await this.workerPromise;
        if ( worker === null ) {
            const result = serialize(data, options);
            this.countdownWorker();
            return result;
        }
        const id = this.jobIdGenerator++;
        return new Promise(resolve => {
            const job = { what: 'serialize', id, data, options };
            this.jobs.set(job.id, resolve);
            worker.postMessage(job);
        });
    }

    async deserialize(data, options) {
        this.workerAccessTime = Date.now();
        const worker = await this.workerPromise;
        if ( worker === null ) {
            const result = deserialize(data, options);
            this.countdownWorker();
            return result;
        }
        const id = this.jobIdGenerator++;
        return new Promise(resolve => {
            const job = { what: 'deserialize', id, data, options };
            this.jobs.set(job.id, resolve);
            worker.postMessage(job);
        });
    }
}

const threads = {
    pool: [],
    getThread() {
        for ( const thread of this.pool ) {
            if ( thread.jobs.size === 0 ) { return thread; }
        }
        const len = this.pool.length;
        if ( len !== 0 && len === currentConfig.maxThreadCount ) {
            if ( len === 1 ) { return this.pool[0]; }
            return this.pool.reduce((best, candidate) =>
                candidate.jobs.size < best.jobs.size ? candidate : best
            );
        }
        const thread = new Thread(thread => {
            const pos = this.pool.indexOf(thread);
            if ( pos === -1 ) { return; }
            this.pool.splice(pos, 1);
        });
        this.pool.push(thread);
        return thread;
    },
    async serialize(data, options) {
        return this.getThread().serialize(data, options);
    },
    async deserialize(data, options) {
        return this.getThread().deserialize(data, options);
    },
};

export async function serializeAsync(data, options = {}) {
    if ( options.thread !== true ) {
        return serialize(data, options);
    }
    const result = await threads.serialize(data, options);
    if ( result !== undefined ) { return result; }
    return serialize(data, options);
}

export async function deserializeAsync(data, options = {}) {
    if ( options.thread !== true ) {
        return deserialize(data, options);
    }
    const result = await threads.deserialize(data, options);
    if ( result !== undefined ) { return result; }
    return deserialize(data, options);
}

/*******************************************************************************
 * 
 * Worker-only code
 * 
 * */

if ( globalThis.WorkerGlobalScope && globalThis instanceof globalThis.WorkerGlobalScope ) {
    globalThis.onmessage = ev => {
        const msg = ev.data;
        switch ( msg.what ) {
            case 'ready?':
                setConfig(msg.config);
                globalThis.postMessage({ what: 'ready!' });
                break;
            case 'serialize':
            case 'deserialize': {
                const result = msg.what === 'serialize'
                    ? serialize(msg.data, msg.options)
                    : deserialize(msg.data);
                globalThis.postMessage({ id: msg.id, result });
                break;
            }
        }
    };
}

/******************************************************************************/
