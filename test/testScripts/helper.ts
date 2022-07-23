type RecursivelyReplaceNullWithUndefined<T> = T extends null
    ? undefined
    : T extends (infer U)[]
    ? RecursivelyReplaceNullWithUndefined<U>[]
    : T extends Record<string, unknown>
    ? { [K in keyof T]: RecursivelyReplaceNullWithUndefined<T[K]> }
    : T;

export function nullsToUndefined<T>(
    obj: T
): RecursivelyReplaceNullWithUndefined<T> {
    if (obj === null || obj === undefined) {
        return undefined as any;
    }

    if ((obj as any).constructor.name === 'Object' || Array.isArray(obj)) {
        for (const key in obj) {
            // console.log('ASDASDASD', key, typeof key, typeof obj);
            // if (typeof key === 'string') {
            try {
                obj[key] = nullsToUndefined(obj[key]) as any;
            } catch (e) {
                // console.log(e);
            }
            // }
        }
    }
    // console.log(obj);
    return obj as any;
}

export function sanitizePoolData(arr) {
    // console.log(arr.default)
    for (let pool of arr) {
        if (pool.expiryTime === null) {
            pool.expiryTime = undefined;
        }
    }
    return arr;
}
