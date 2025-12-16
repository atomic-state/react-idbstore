import { useState, useEffect, useMemo } from "react";
import { liveQuery, Dexie, Table, Collection } from "dexie";

type ComparisonOperators<Value = any> = {
  $gt?: Value;
  $gte?: Value;
  $lt?: Value;
  $lte?: Value;
  $in?: Value[];
  $contains?: any;
};

type EqualityCondition<T> = {
  [P in keyof T]?: T[P] | DeepPartial<T[P]> | ComparisonOperators<T[P]>;
};

type LogicalCondition<T> = {
  $and?: (WhereClause<T> | EqualityCondition<T>)[];
  $or?: (WhereClause<T> | EqualityCondition<T>)[];
};

export type WhereClause<T> =
  | DeepPartial<T>
  | LogicalCondition<T>
  | EqualityCondition<T>;

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

export type SelectClause<T> = {
  [P in keyof T]?: T[P] extends object ? SelectClause<T[P]> | true : true;
};

type ApplySelect<T, S> = S extends SelectClause<T>
  ? {
      [P in keyof S & keyof T]: S[P] extends true
        ? T[P]
        : S[P] extends object
        ? ApplySelect<T[P], S[P]>
        : never;
    }
  : T;

/**
 * The structure of a record as stored in IndexedDB (includes the auto-incremented id).
 */
export type StoreRecord<StoreSchema> = {
  id: number;
  object: StoreSchema;
};

type InternalUpdatePayload<StoreSchema> = Array<{
  id: number;
  changes: Partial<StoreSchema>;
}>;

type ExternalUpdatePayload<StoreSchema> = Array<{
  key: keyof StoreSchema;
  value: any;
  changes: Partial<StoreSchema>;
}>;

export type CreateStoreDefinition = {
  name: string;
  version?: number;
  indexSpec?: string;
};

// Utilities
const isObject = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const sortObjectKeys = (obj: any): any => {
  if (!isObject(obj) && !Array.isArray(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sortedKeys = Object.keys(obj).sort();
  const sortedObject: any = {};
  for (const key of sortedKeys) {
    sortedObject[key] = sortObjectKeys(obj[key]);
  }
  return sortedObject;
};

const djb2Hash32 = (str: string) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
};

const contentKeyFor = (obj: any) => {
  try {
    const sorted = sortObjectKeys(obj);
    const s = JSON.stringify(sorted);
    return djb2Hash32(s);
  } catch {
    return String(Math.random());
  }
};

export function robustJsonCompare(a: any, b: any): boolean {
  if (a === b) return true;
  try {
    const sortedA = sortObjectKeys(a);
    const sortedB = sortObjectKeys(b);
    return JSON.stringify(sortedA) === JSON.stringify(sortedB);
  } catch {
    return false;
  }
}

// Matcher: recursive and supports operators

function primitiveEqual(a: any, b: any) {
  return a === b;
}

function matchComparisonOperators(
  value: any,
  operators: ComparisonOperators<any>
): boolean {
  if (!isObject(operators)) return false;
  for (const op of Object.keys(
    operators
  ) as (keyof ComparisonOperators<any>)[]) {
    const v = (operators as any)[op];
    switch (op) {
      case "$gt":
        if (!(value > v)) return false;
        break;
      case "$gte":
        if (!(value >= v)) return false;
        break;
      case "$lt":
        if (!(value < v)) return false;
        break;
      case "$lte":
        if (!(value <= v)) return false;
        break;
      case "$in":
        if (
          !Array.isArray(v) ||
          !v.some((x: any) => robustJsonCompare(x, value))
        )
          return false;
        break;
      case "$contains":
        if (Array.isArray(value)) {
          if (!value.some((x) => robustJsonCompare(x, v))) return false;
        } else if (typeof value === "string") {
          if (typeof v !== "string" || !value.includes(v)) return false;
        } else {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function applySelect<T>(obj: T, select?: SelectClause<T>): any {
  if (!select) return obj;
  if (!isObject(obj)) return obj;

  const result: any = {};
  for (const key of Object.keys(select)) {
    const selector = (select as any)[key];
    const value = (obj as any)[key];

    if (selector === true) {
      result[key] = value;
    } else if (isObject(selector) && isObject(value)) {
      result[key] = applySelect(value, selector);
    }
  }
  return result;
}

/**
 * Evaluates a WhereClause condition against a single record payload.
 * Supports nested equality, $and, $or, and comparison operators.
 */
function evaluateCondition<StoreSchema>(
  itemPayload: any,
  condition: WhereClause<StoreSchema> | EqualityCondition<StoreSchema>
): boolean {
  if (condition === null || condition === undefined) return false;

  // Logical operators at top
  // @ts-expect-error
  if (isObject(condition) && ("$or" in condition || "$and" in condition)) {
    const condAny = condition as any;
    if ("$or" in condAny) {
      if (!Array.isArray(condAny.$or)) return false;
      return condAny.$or.some((c: any) => evaluateCondition(itemPayload, c));
    }
    if ("$and" in condAny) {
      if (!Array.isArray(condAny.$and)) return false;
      return condAny.$and.every((c: any) => evaluateCondition(itemPayload, c));
    }
  }

  // condition is an object mapping keys to expected values/operators
  if (!isObject(condition)) {
    // Should not happen normally - compare strictly
    return primitiveEqual(itemPayload, condition);
  }

  if (!isObject(itemPayload)) return false;

  for (const key of Object.keys(condition)) {
    const filterValue = (condition as any)[key];
    const itemValue = itemPayload[key];

    // If filterValue is operator object (e.g. { $gt: 5 })
    if (
      isObject(filterValue) &&
      Object.keys(filterValue).some((k) => k.startsWith("$"))
    ) {
      if (
        !matchComparisonOperators(
          itemValue,
          filterValue as ComparisonOperators<any>
        )
      )
        return false;
      continue;
    }

    // If both are arrays: require same length and deep-equal per index
    if (Array.isArray(filterValue)) {
      if (!Array.isArray(itemValue)) return false;
      if (filterValue.length !== itemValue.length) return false;
      for (let i = 0; i < filterValue.length; i++) {
        if (!robustJsonCompare(filterValue[i], itemValue[i])) return false;
      }
      continue;
    }

    // If filterValue is an object: recurse
    if (isObject(filterValue)) {
      if (!isObject(itemValue)) return false;
      if (!evaluateCondition(itemValue, filterValue)) return false;
      continue;
    }

    // Primitive comparison
    if (!primitiveEqual(itemValue, filterValue)) return false;
  }
  return true;
}

// Main factory

export function createIDBStore<StoreSchema = any>(
  definition: CreateStoreDefinition
) {
  const { name, version = 1, indexSpec } = definition;

  const idb = new Dexie(name);

  // Build stores definition string preserving backward compatibility
  // If indexSpec is provided, use it; otherwise default to '++id, object'
  const storeDef =
    indexSpec && indexSpec.length > 0 ? indexSpec : "++id, object";

  // note: stores expects an object map: { storeName: "++id, ..." }
  idb.version(version).stores({ [name]: storeDef });

  const collection: Table<StoreRecord<StoreSchema>, number> = (idb as any)[
    name
  ];

  const normalizeWhere = (where?: WhereClause<StoreSchema>) => {
    if (!where) return "";
    try {
      return JSON.stringify(sortObjectKeys(where as any));
    } catch {
      return String(where as any);
    }
  };

  type CacheEntry = {
    contentKey: string;
    result: any;
    lastUsed: number;
  };

  const CACHE_MAX = 500; // soft cap, tune as needed
  const queryResultCache = new Map<string, CacheEntry>();

  const makeQueryKey = (
    where?: WhereClause<StoreSchema>,
    select?: SelectClause<StoreSchema>
  ) => {
    try {
      const w = where === undefined ? null : sortObjectKeys(where as any);
      const s = select === undefined ? null : sortObjectKeys(select as any);
      return JSON.stringify({ w, s, name });
    } catch {
      // fallback - not ideal but safe
      return String(Math.random());
    }
  };

  const ensureCacheLimit = () => {
    if (queryResultCache.size <= CACHE_MAX) return;
    // evict least recently used (smallest lastUsed)
    const entries = Array.from(queryResultCache.entries());
    entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = entries.slice(0, entries.length - CACHE_MAX);
    for (const [k] of toRemove) queryResultCache.delete(k);
  };

  const findFirst = async <
    S extends SelectClause<StoreSchema> | undefined
  >(params: {
    where: WhereClause<StoreSchema>;
    select?: S;
  }) => {
    const { where, select } = params;

    const record = await collection
      .toCollection()
      .filter((item) => evaluateCondition(item.object, where))
      .first();

    if (!record) return undefined;

    return {
      ...record,
      object: applySelect(record.object, select),
    } as StoreRecord<
      S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
    >;
  };

  const findLast = async <
    S extends SelectClause<StoreSchema> | undefined
  >(params: {
    where: WhereClause<StoreSchema>;
    select?: S;
  }) => {
    const { where, select } = params;

    const record = await collection
      .toCollection()
      .reverse()
      .filter((item) => evaluateCondition(item.object, where))
      .first();

    if (!record) return undefined;

    return {
      ...record,
      object: applySelect(record.object, select),
    } as StoreRecord<
      S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
    >;
  };

  const findMany = async <
    S extends SelectClause<StoreSchema> | undefined
  >(params: {
    where: WhereClause<StoreSchema>;
    select?: S;
  }): Promise<
    Array<
      StoreRecord<
        S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
      >
    >
  > => {
    const { where, select } = params;

    const records = await collection
      .toCollection()
      .filter((item) => evaluateCondition(item.object, where))
      .toArray();

    return records.map((r) => ({
      ...r,
      object: applySelect(r.object, select),
    })) as any;
  };

  /**
   * Finds many records matching a criteria and returns the array of 'object' fields (the StoreSchema)
   * instead of the full StoreRecord ({ id, object }).
   */
  const findManyFlat = async <
    S extends SelectClause<StoreSchema> | undefined
  >(params: {
    where: WhereClause<StoreSchema>;
    select?: S;
  }): Promise<
    Array<S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>>
  > => {
    const { where, select } = params;

    const records = await collection
      .toCollection()
      .filter((item) => evaluateCondition(item.object, where))
      .toArray();

    return records.map((r) => applySelect(r.object, select)) as any;
  };

  const addItem = async (item: StoreSchema) => {
    const data: StoreRecord<StoreSchema> = {
      object: item,
    } as StoreRecord<StoreSchema>;
    try {
      const key = await collection.add(data as any);
      return key as number;
    } catch (err) {
      console.error(`Failed to add item to ${name}:`, err);
      throw err;
    }
  };

  const addMany = async (items: StoreSchema[]) => {
    try {
      // @ts-expect-error
      const itemsForInsertion: StoreRecord<StoreSchema>[] = items.map(
        (item) => ({ object: item })
      );
      const lastKey = (await collection.bulkAdd(
        itemsForInsertion as any[]
      )) as unknown as number;
      return lastKey;
    } catch (err) {
      console.error(`Failed to bulk add items to ${name}:`, err);
      throw err;
    }
  };

  const deleteItem = async (id: number) => {
    try {
      await collection.delete(id);
    } catch (err) {
      console.error(`Failed to delete item with id ${id}:`, err);
      throw err;
    }
  };

  const deleteMany = async (ids: number[]) => {
    try {
      await idb.transaction("rw", collection, async () => {
        await collection.bulkDelete(ids);
      });
    } catch (err) {
      console.error(
        `Failed to bulk delete items with ids ${ids.join(",")}:`,
        err
      );
      throw err;
    }
  };

  const deleteManyWhere = async (
    where: WhereClause<StoreSchema>
  ): Promise<number> => {
    try {
      let deletedCount = 0;

      await idb.transaction("rw", collection, async () => {
        const toDelete = await collection
          .toCollection()
          .filter((item) => evaluateCondition(item.object, where))
          .primaryKeys();

        if (toDelete.length === 0) return;

        await collection.bulkDelete(toDelete as number[]);
        deletedCount = toDelete.length;
      });

      return deletedCount;
    } catch (err) {
      console.error(`Failed to bulk delete many where in ${name}:`, err);
      throw err;
    }
  };

  const updateItem = async (
    id: number,
    update:
      | Partial<StoreSchema>
      | ((previousValue: StoreSchema) => Partial<StoreSchema>)
  ) => {
    try {
      const previousRecord = await collection.get(id);
      if (!previousRecord) throw new Error(`Record with id ${id} not found`);
      const previousValue = previousRecord.object;
      const updatedObject =
        typeof update === "function" ? update(previousValue) : update;
      await collection.update(id, {
        object: {
          ...previousValue,
          ...(updatedObject as Partial<StoreSchema>),
        },
      } as any);
      return 1;
    } catch (err) {
      console.error(`Failed to update item with id ${id}:`, err);
      throw err;
    }
  };

  const updateAllWhere = async (
    where: WhereClause<StoreSchema>,
    partialUpdate: Partial<StoreSchema>
  ): Promise<number> => {
    try {
      let updatedCount = 0;
      await idb.transaction("rw", collection, async () => {
        const collectionToUpdate = collection
          .toCollection()
          .filter((item) => evaluateCondition(item.object, where));
        const modifier = (item: StoreRecord<StoreSchema>) => {
          // merge partial update in-place
          item.object = {
            ...(item.object as any),
            ...(partialUpdate as any),
          } as StoreSchema;
        };
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - Dexie typing for Collection.modify isn't easily expressible here
        updatedCount = await collectionToUpdate.modify(modifier);
      });
      return updatedCount;
    } catch (err) {
      console.error(`Failed to bulk update all where in ${name}:`, err);
      throw err;
    }
  };

  const updateManyByInternalId = async (
    updates: InternalUpdatePayload<StoreSchema>
  ): Promise<number> => {
    try {
      const ids = updates.map((u) => u.id);
      const existingRecords = await collection.bulkGet(ids);
      const recordsToPut: StoreRecord<StoreSchema>[] = [];
      existingRecords.forEach((record, index) => {
        const update = updates[index];
        if (record && update) {
          recordsToPut.push({
            id: record.id,
            object: {
              ...(record.object as any),
              ...(update.changes as any),
            } as StoreSchema,
          });
        }
      });
      if (recordsToPut.length === 0) return 0;
      await idb.transaction("rw", collection, async () => {
        await collection.bulkPut(recordsToPut as any[]);
      });
      return recordsToPut.length;
    } catch (err) {
      console.error(`Failed to bulk update by internal ID in ${name}:`, err);
      throw err;
    }
  };

  const updateManyByExternalKey = async (
    updates: ExternalUpdatePayload<StoreSchema>
  ): Promise<number> => {
    try {
      if (!updates || updates.length === 0) return 0;
      // Fetch all records once and do in-memory matching to avoid N+1
      const allRecords = await collection.toArray();
      const idToUpdatedObject = new Map<number, StoreSchema>();
      for (const update of updates) {
        const candidates = allRecords.filter((rec) =>
          robustJsonCompare((rec.object as any)[update.key], update.value)
        );
        for (const rec of candidates) {
          const merged = {
            ...(rec.object as any),
            ...(update.changes as any),
          } as StoreSchema;
          idToUpdatedObject.set(rec.id, merged);
        }
      }
      if (idToUpdatedObject.size === 0) return 0;
      const toPut: StoreRecord<StoreSchema>[] = Array.from(
        idToUpdatedObject.entries()
      ).map(([id, object]) => ({ id, object }));
      await idb.transaction("rw", collection, async () => {
        await collection.bulkPut(toPut as any[]);
      });
      return toPut.length;
    } catch (err) {
      console.error(`Failed to update by external key in ${name}:`, err);
      throw err;
    }
  };

  const useRecords = <S extends SelectClause<StoreSchema> | undefined>({
    where,
    select,
    onError,
  }: {
    where?: WhereClause<StoreSchema>;
    select?: S;
    onError?: (error: Error) => void;
  } = {}) => {
    const [objects, setObjects] = useState<
      Array<
        StoreRecord<
          S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
        >
      >
    >([]);

    // memoized normalized where string (deterministic)
    const normalizedWhere = useMemo(() => normalizeWhere(where), [where]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        const queryKey = makeQueryKey(where, select);

        let query: Collection<
          StoreRecord<StoreSchema>,
          number
        > = collection.toCollection();
        if (where && Object.keys(where as any).length > 0) {
          query = query.filter((item) => evaluateCondition(item.object, where));
        }
        const results = await query.toArray();

        // Prepare compact content keys using djb2Hash32 over sorted JSON
        const withContentKey = results.map((r) => {
          const selectedObject = applySelect(r.object, select);
          const key = contentKeyFor(selectedObject);

          return {
            ...r,
            object: selectedObject,
            _contentKey: key,
          };
        });

        // Compute combined content key for whole result set
        const combined = djb2Hash32(
          withContentKey.map((r) => r._contentKey).join("|")
        );

        // Check cache
        const cached = queryResultCache.get(queryKey);
        if (cached && cached.contentKey === combined) {
          // update lastUsed and return same reference
          cached.lastUsed = Date.now();
          return cached.result;
        }

        // Not cached or stale → set cache
        const entry: CacheEntry = {
          contentKey: combined,
          result: withContentKey,
          lastUsed: Date.now(),
        };
        queryResultCache.set(queryKey, entry);
        ensureCacheLimit();

        return withContentKey as any;
      });

      const subscription = observable.subscribe({
        next: (
          newResults: Array<
            StoreRecord<
              S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
            > & { _contentKey: string }
          >
        ) => {
          setObjects((previousResults) => {
            if (previousResults.length !== newResults.length)
              return newResults.map(({ _contentKey, ...rest }) => rest);
            if (previousResults.length === 0) return [];

            const prevMap: Record<number, string> = Object.fromEntries(
              previousResults.map((r) => [r.id, contentKeyFor(r.object)])
            );
            for (const newRec of newResults) {
              const prevKey = prevMap[newRec.id];
              if (prevKey === undefined) {
                return newResults.map(({ _contentKey, ...rest }) => rest);
              }
              if (prevKey !== newRec._contentKey) {
                return newResults.map(({ _contentKey, ...rest }) => rest);
              }
            }
            return previousResults;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObjects([]);
        },
      });

      return () => subscription.unsubscribe();
    }, [name, normalizedWhere, select]); // Added 'select' to dependency array for correctness

    return objects;
  };

  /**
   * Same as useRecords, but returns an array of the 'object' field (the StoreSchema)
   * instead of the full StoreRecord ({ id, object }).
   */
  const useRecordsFlat = <S extends SelectClause<StoreSchema> | undefined>({
    where,
    select,
    onError,
  }: {
    where?: WhereClause<StoreSchema>;
    select?: S;
    onError?: (error: Error) => void;
  } = {}) => {
    type FlatObject = S extends undefined
      ? StoreSchema
      : ApplySelect<StoreSchema, S>;

    const [objects, setObjects] = useState<Array<FlatObject>>([]);

    // memoized normalized where string (deterministic)
    const normalizedWhere = useMemo(() => normalizeWhere(where), [where]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        const queryKey = makeQueryKey(where, select);

        let query: Collection<
          StoreRecord<StoreSchema>,
          number
        > = collection.toCollection();
        if (where && Object.keys(where as any).length > 0) {
          query = query.filter((item) => evaluateCondition(item.object, where));
        }
        const results = await query.toArray();

        // Prepare compact content keys using djb2Hash32 over sorted JSON
        const withContentKey = results.map((r) => {
          const selectedObject = applySelect(r.object, select);
          const key = contentKeyFor(selectedObject);

          // We return the flat object and its content key for comparison
          return {
            object: selectedObject as FlatObject,
            id: r.id, // Keep ID for mapping to previous results
            _contentKey: key,
          };
        });

        // Compute combined content key for whole result set
        const combined = djb2Hash32(
          withContentKey.map((r) => r._contentKey).join("|")
        );

        // Check cache
        const cached = queryResultCache.get(queryKey);
        // Note: For useRecordsFlat, the cached result is already the flat array
        if (cached && cached.contentKey === combined) {
          // update lastUsed and return same reference
          cached.lastUsed = Date.now();
          return cached.result;
        }

        // The result to be returned and cached is the array of flat objects
        const flatResults = withContentKey.map((r) => r.object);

        // Not cached or stale → set cache
        const entry: CacheEntry = {
          contentKey: combined,
          result: flatResults, // Cache the flat array
          lastUsed: Date.now(),
        };
        queryResultCache.set(queryKey, entry);
        ensureCacheLimit();

        // Return the flat array for immediate use by the component (which will be a new reference)
        return flatResults as Array<FlatObject>;
      });

      const subscription = observable.subscribe({
        next: (newResults: Array<FlatObject>) => {
          setObjects((previousResults) => {
            // The content comparison logic is more complex for flat arrays without content keys.
            // We perform a deep compare as a final check to prevent re-renders on identical content,
            // in case the cache or change detection failed to return the same reference.

            if (previousResults === newResults) return previousResults; // Should be caught by cache
            if (previousResults.length !== newResults.length) return newResults;

            let needsUpdate = false;
            for (let i = 0; i < previousResults.length; i++) {
              if (!robustJsonCompare(previousResults[i], newResults[i])) {
                needsUpdate = true;
                break;
              }
            }

            return needsUpdate ? newResults : previousResults;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObjects([]);
        },
      });

      return () => subscription.unsubscribe();
    }, [name, normalizedWhere, select]);

    return objects;
  };

  const useRecord = <S extends SelectClause<StoreSchema> | undefined>({
    where,
    select,
    onError,
  }: {
    where: WhereClause<StoreSchema>;
    select?: S;
    onError?: (error: Error) => void;
  }) => {
    const [object, setObject] = useState<StoreRecord<
      S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
    > | null>(null);

    // memoized normalized where string (deterministic)
    const normalizedWhere = useMemo(() => normalizeWhere(where), [where]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        const queryKey = makeQueryKey(where, select);

        const record = await collection
          .toCollection()
          .filter((item) => evaluateCondition(item.object, where))
          .first();

        if (!record) return null;

        const selectedObject = applySelect(record.object, select);
        const key = contentKeyFor(selectedObject);

        const wrapped = {
          ...record,
          object: selectedObject,
          _contentKey: key,
        } as any;

        const cached = queryResultCache.get(queryKey);
        if (cached && cached.contentKey === key) {
          cached.lastUsed = Date.now();
          return cached.result;
        }

        const entry: CacheEntry = {
          contentKey: key,
          result: wrapped,
          lastUsed: Date.now(),
        };
        queryResultCache.set(queryKey, entry);
        ensureCacheLimit();

        return wrapped;
      });

      const subscription = observable.subscribe({
        next: (
          newResult:
            | (StoreRecord<
                S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
              > & { _contentKey: string })
            | null
        ) => {
          setObject((previousResult) => {
            // null handling
            if (!previousResult && !newResult) return null;
            if (!previousResult && newResult) {
              const { _contentKey, ...rest } = newResult;
              return rest;
            }
            if (previousResult && !newResult) return null;

            // both exist = compare content key
            const prevKey = contentKeyFor(previousResult!.object);
            if (prevKey !== newResult!._contentKey) {
              const { _contentKey, ...rest } = newResult!;
              return rest;
            }

            return previousResult;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObject(null);
        },
      });

      return () => subscription.unsubscribe();
    }, [name, normalizedWhere, select]); // Added 'select' to dependency array for correctness

    return object;
  };

  const useFirstRecord = <S extends SelectClause<StoreSchema> | undefined>({
    where,
    select,
    onError,
  }: {
    where: WhereClause<StoreSchema>;
    select?: S;
    onError?: (error: Error) => void;
  }) => {
    const [object, setObject] = useState<StoreRecord<
      S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
    > | null>(null);

    const normalizedWhere = useMemo(() => normalizeWhere(where), [where]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        const queryKey = makeQueryKey(where, select);

        const record = await collection
          .toCollection()
          .filter((item) => evaluateCondition(item.object, where))
          .first();

        if (!record) return null;

        const selectedObject = applySelect(record.object, select);
        const key = contentKeyFor(selectedObject);

        const wrapped = {
          ...record,
          object: selectedObject,
          _contentKey: key,
        } as any;

        const cached = queryResultCache.get(queryKey);
        if (cached && cached.contentKey === key) {
          cached.lastUsed = Date.now();
          return cached.result;
        }

        const entry: CacheEntry = {
          contentKey: key,
          result: wrapped,
          lastUsed: Date.now(),
        };
        queryResultCache.set(queryKey, entry);
        ensureCacheLimit();

        return wrapped;
      });

      const subscription = observable.subscribe({
        next: (
          newResult:
            | (StoreRecord<
                S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
              > & { _contentKey: string })
            | null
        ) => {
          setObject((previousResult) => {
            if (!previousResult && !newResult) return null;
            if (!previousResult && newResult) {
              const { _contentKey, ...rest } = newResult;
              return rest;
            }
            if (previousResult && !newResult) return null;

            const prevKey = contentKeyFor(previousResult!.object);
            if (prevKey !== newResult!._contentKey) {
              const { _contentKey, ...rest } = newResult!;
              return rest;
            }

            return previousResult;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObject(null);
        },
      });

      return () => subscription.unsubscribe();
    }, [name, normalizedWhere, select]); // Added 'select' to dependency array for correctness

    return object;
  };

  const useLastRecord = <S extends SelectClause<StoreSchema> | undefined>({
    where,
    select,
    onError,
  }: {
    where: WhereClause<StoreSchema>;
    select?: S;
    onError?: (error: Error) => void;
  }) => {
    const [object, setObject] = useState<StoreRecord<
      S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
    > | null>(null);

    const normalizedWhere = useMemo(() => normalizeWhere(where), [where]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        const queryKey = makeQueryKey(where, select);

        const record = await collection
          .toCollection()
          .reverse()
          .filter((item) => evaluateCondition(item.object, where))
          .first();

        if (!record) return null;

        const selectedObject = applySelect(record.object, select);
        const key = contentKeyFor(selectedObject);

        const wrapped = {
          ...record,
          object: selectedObject,
          _contentKey: key,
        } as any;

        const cached = queryResultCache.get(queryKey);
        if (cached && cached.contentKey === key) {
          cached.lastUsed = Date.now();
          return cached.result;
        }

        const entry: CacheEntry = {
          contentKey: key,
          result: wrapped,
          lastUsed: Date.now(),
        };
        queryResultCache.set(queryKey, entry);
        ensureCacheLimit();

        return wrapped;
      });

      const subscription = observable.subscribe({
        next: (
          newResult:
            | (StoreRecord<
                S extends undefined ? StoreSchema : ApplySelect<StoreSchema, S>
              > & { _contentKey: string })
            | null
        ) => {
          setObject((previousResult) => {
            if (!previousResult && !newResult) return null;
            if (!previousResult && newResult) {
              const { _contentKey, ...rest } = newResult;
              return rest;
            }
            if (previousResult && !newResult) return null;

            const prevKey = contentKeyFor(previousResult!.object);
            if (prevKey !== newResult!._contentKey) {
              const { _contentKey, ...rest } = newResult!;
              return rest;
            }

            return previousResult;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObject(null);
        },
      });

      return () => subscription.unsubscribe();
    }, [name, normalizedWhere, select]); // Added 'select' to dependency array for correctness

    return object;
  };

  return {
    collection,
    addItem,
    findMany,
    findManyFlat,
    findFirst,
    findLast,
    updateItem,
    updateAllWhere,
    updateManyByInternalId,
    updateManyByExternalKey,
    deleteItem,
    deleteMany,
    deleteManyWhere,
    addMany,
    useRecords,
    useRecordsFlat,
    useRecord,
    useFirstRecord,
    useLastRecord,
  };
}
