import { useState, useEffect } from "react";
import { liveQuery, Dexie, Table, Collection } from "dexie";

type EqualityCondition<T> = {
  [P in keyof T]?: T[P] | DeepPartial<T[P]>;
};

type LogicalCondition<T> = {
  $and?: (WhereClause<T> | EqualityCondition<T>)[];
  $or?: (WhereClause<T> | EqualityCondition<T>)[];
};

export type WhereClause<T> = DeepPartial<T> | LogicalCondition<T>;

type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

/**
 * The structure of a record as stored in IndexedDB (includes the auto-incremented id).
 */
export type StoreRecord<StoreSchema> = {
  id: number;
  object: StoreSchema;
};

/**
 * The payload type for the bulk update by internal ID method.
 */
type InternalUpdatePayload<StoreSchema> = Array<{
  id: number;
  changes: Partial<StoreSchema>;
}>;

/**
 * The payload type for the bulk update by external key method.
 * Uses the simplified 'key' and 'value' fields.
 */
type ExternalUpdatePayload<StoreSchema> = Array<{
  key: keyof StoreSchema;
  value: any;
  changes: Partial<StoreSchema>;
}>;

/**
 * Recursively sorts object keys for deterministic JSON string comparison.
 * @param obj The object to sort.
 * @returns An object with sorted keys.
 */
const sortObjectKeys = (obj: any): any => {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sortedKeys = Object.keys(obj).sort();
  const sortedObject: any = {};
  for (const key of sortedKeys) {
    sortedObject[key] = sortObjectKeys(obj[key]);
  }
  return sortedObject;
};

/**
 * Performs a robust deep comparison of two objects by standardizing and stringifying their JSON structure.
 * This is used to prevent unnecessary React re-renders.
 * @param a The first object.
 * @param b The second object.
 * @returns True if the contents are identical, regardless of key order.
 */
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

/**
 * Evaluates a WhereClause condition against a single record payload.
 * Supports nested equality, $and, and $or logic.
 */
function evaluateCondition<StoreSchema>(
  itemPayload: StoreSchema,
  condition: WhereClause<StoreSchema> | EqualityCondition<StoreSchema>
): boolean {
  if (!condition || typeof condition !== "object") return false;

  const keys = Object.keys(condition);

  if (keys.includes("$or")) {
    const orConditions = (condition as LogicalCondition<StoreSchema>).$or || [];

    return orConditions.some((c) => evaluateCondition(itemPayload, c));
  }

  if (keys.includes("$and")) {
    const andConditions =
      (condition as LogicalCondition<StoreSchema>).$and || [];

    return andConditions.every((c) => evaluateCondition(itemPayload, c));
  }

  for (const topLevelKey of keys as (keyof StoreSchema)[]) {
    const filterValue = (condition as any)[topLevelKey];
    const itemValue = itemPayload[topLevelKey];

    if (
      typeof filterValue === "object" &&
      filterValue !== null &&
      !Array.isArray(filterValue)
    ) {
      const nestedKeys = Object.keys(filterValue);

      if (typeof itemValue !== "object" || itemValue === null) return false;

      for (const nestedKey of nestedKeys) {
        if ((itemValue as any)[nestedKey] !== filterValue[nestedKey]) {
          return false;
        }
      }
    } else if (itemValue !== filterValue) {
      return false;
    }
  }

  return true;
}

/**
 * Creates an isolated, type-safe data store based on Dexie (IndexedDB).
 */
export function createIDBStore<StoreSchema = any>(definition: {
  name: string;
  version?: number;
}) {
  const { name, version = 1 } = definition;

  const idb = new Dexie(name);

  idb.version(version).stores({
    [name]: "++id, object",
  });

  const collection: Table<StoreRecord<StoreSchema>, number> = (idb as any)[
    name
  ];

  /**
   * Finds the first record (lowest ID) matching the WhereClause criteria.
   * Uses the forward cursor and stops immediately on the first match.
   * @param where The filtering criteria (WhereClause<StoreSchema>).
   * @returns A Promise that resolves to the first matching StoreRecord, or undefined.
   */
  const findFirst = async (where: WhereClause<StoreSchema>) => {
    try {
      // Start forward cursor scan (lowest ID first)
      const matchingRecord = await collection
        .toCollection()
        .filter((item) => {
          return evaluateCondition(item.object, where);
        })
        .first();

      return matchingRecord;
    } catch (err) {
      console.error(`Failed to find first in ${name}:`, err);
      throw err;
    }
  };

  /**
   * Finds the last record (highest ID) matching the WhereClause criteria.
   * This is optimized by using a reverse cursor scan on the primary key, stopping immediately on the first match.
   * @param where The filtering criteria (WhereClause<StoreSchema>).
   * @returns A Promise that resolves to the last matching StoreRecord, or undefined.
   */
  const findLast = async (where: WhereClause<StoreSchema>) => {
    try {
      // Start reverse cursor scan (highest ID first)
      const matchingRecord = await collection
        .toCollection()
        .reverse()
        .filter((item) => {
          return evaluateCondition(item.object, where);
        })
        .first();

      return matchingRecord;
    } catch (err) {
      console.error(`Failed to find last in ${name}:`, err);
      throw err;
    }
  };

  /**
   * Finds all records matching the WhereClause criteria.
   * Iterates the full collection and returns all matching records.
   * @param where The filtering criteria (WhereClause<StoreSchema>).
   * @returns A Promise that resolves to an array of matching StoreRecords.
   */
  const findMany = async (where: WhereClause<StoreSchema>) => {
    try {
      // Get all records and apply the client-side filter.
      const matchingRecords = await collection
        .toCollection()
        .filter((item) => {
          return evaluateCondition(item.object, where);
        })
        .toArray();

      return matchingRecords;
    } catch (err) {
      console.error(`Failed to find many in ${name}:`, err);
      throw err;
    }
  };

  /**
   * Adds a single item to the store.
   * @param item The StoreSchema object to add.
   * @returns A Promise that resolves to the primary key (ID) of the new item.
   */
  const addItem = async (item: StoreSchema) => {
    // @ts-expect-error
    const data: StoreRecord<StoreSchema> = { object: item };
    try {
      return await collection.add(data as any);
    } catch (err) {
      console.error(`Failed to add item to ${name}:`, err);
      throw err;
    }
  };

  /**
   * Adds multiple items to the store in a single transaction.
   * @param items An array of StoreSchema objects to add.
   * @returns A Promise that resolves to the primary key (ID) of the last added item.
   */
  const addMany = async (items: StoreSchema[]) => {
    try {
      // @ts-expect-error
      const itemsForInsertion: StoreRecord<StoreSchema>[] = items.map(
        (item) => ({
          object: item,
        })
      );

      const lastKey = await collection.bulkAdd(itemsForInsertion);

      return lastKey;
    } catch (err) {
      console.error(`Failed to bulk add items to ${name}:`, err);
      throw err;
    }
  };

  /**
   * Deletes a single item using its primary key (ID).
   * @param id The primary key (ID) of the item to delete.
   * @returns A Promise that resolves when the deletion is complete (void).
   */
  const deleteItem = async (id: number) => {
    try {
      await collection.delete(id);
    } catch (err) {
      console.error(`Failed to delete item with id ${id}:`, err);
      throw err;
    }
  };

  /**
   * Deletes multiple items using their primary keys (IDs) in a single transaction.
   * @param ids An array of primary keys (IDs) to delete.
   * @returns A Promise that resolves when the bulk deletion is complete (void).
   */
  const deleteMany = async (ids: number[]) => {
    try {
      await collection.bulkDelete(ids);
    } catch (err) {
      console.error(
        `Failed to bulk delete items with ids ${ids.join(",")}:`,
        err
      );
      throw err;
    }
  };

  /**
   * Updates a record by its primary key (ID) using a partial update or a state function.
   * @param id The primary key (ID) of the item to update.
   * @param update The partial StoreSchema object or a function that receives the previous value.
   * @returns A Promise that resolves to 1 (success) or throws on failure.
   */
  const updateItem = async (
    id: number,
    update:
      | Partial<StoreSchema>
      | ((previousValue: StoreSchema) => Partial<StoreSchema>)
  ) => {
    try {
      const previousValue = await collection.get(id);

      const updatedObject =
        typeof update === "function" ? update(previousValue?.object!) : update;

      await collection.update(id, {
        // @ts-expect-error
        object: {
          ...previousValue?.object,
          ...updatedObject,
        },
      });
      return 1;
    } catch (err) {
      console.error(`Failed to update item with id ${id}:`, err);
      throw err;
    }
  };

  /**
   * Updates ALL records matching the criteria with the SAME partial update object.
   * @param where The filtering criteria (WhereClause<StoreSchema>).
   * @param partialUpdate The partial StoreSchema object to apply to ALL matching records.
   * @returns A Promise that resolves to the number of records updated.
   */
  const updateAllWhere = async (
    where: WhereClause<StoreSchema>,
    partialUpdate: Partial<StoreSchema>
  ): Promise<number> => {
    try {
      const collectionToUpdate = collection.toCollection().filter((item) => {
        return evaluateCondition(item.object, where);
      });

      const modifier = (item: StoreRecord<StoreSchema>) => {
        // @ts-ignore: We know 'object' exists and we are merging partialUpdate into it
        item.object = { ...item.object, ...partialUpdate };
      };

      const recordsUpdated = await collectionToUpdate.modify(modifier);

      return recordsUpdated;
    } catch (err) {
      console.error(`Failed to bulk update all where in ${name}:`, err);
      throw err;
    }
  };

  /**
   * Performs a high-performance bulk update on multiple records using their internal primary keys (IDs).
   * Changes are merged into the existing object payload.
   * @param updates An array of objects, each containing the internal 'id' and the 'changes' (Partial<StoreSchema>) to apply.
   * @returns A Promise that resolves to the number of records successfully updated.
   */
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
              ...record.object,
              ...update.changes,
            } as StoreSchema,
          });
        }
      });

      await collection.bulkPut(recordsToPut);

      return recordsToPut.length;
    } catch (err) {
      console.error(`Failed to bulk update by internal ID in ${name}:`, err);
      throw err;
    }
  };

  /**
   * Synchronizes multiple records by looking them up using an arbitrary external key
   * and applying individual partial updates in a single bulk transaction.
   * @param updates An array defining the match criteria (using 'key' and 'value') and the changes to apply.
   * @returns A Promise that resolves to the number of records successfully updated.
   */
  const updateManyByExternalKey = async (
    updates: ExternalUpdatePayload<StoreSchema>
  ): Promise<number> => {
    try {
      const bulkUpdatesForIDB: InternalUpdatePayload<StoreSchema> = [];

      for (const update of updates) {
        const whereClause = {
          [update.key]: update.value,
        } as WhereClause<StoreSchema>;

        const localRecord = await findFirst(whereClause);

        if (localRecord) {
          bulkUpdatesForIDB.push({
            id: localRecord.id,
            changes: update.changes,
          });
        }
      }

      if (bulkUpdatesForIDB.length > 0) {
        return await updateManyByInternalId(bulkUpdatesForIDB);
      }

      return 0;
    } catch (err) {
      console.error(`Failed to update by external key in ${name}:`, err);
      throw err;
    }
  };

  /**
   * A React hook that subscribes to live record changes based on filter criteria.
   * @param where Optional filtering criteria using WhereClause<StoreSchema> ($and, $or supported).
   * @param onError Optional error handler for liveQuery subscription failures.
   * @returns An array of matching StoreRecords ({ id, object }).
   */
  const useRecords = ({
    where,
    onError,
  }: {
    where?: WhereClause<StoreSchema>;
    onError?: (error: Error) => void;
  } = {}) => {
    const [objects, setObjects] = useState<StoreRecord<StoreSchema>[]>([]);

    useEffect(() => {
      const observable = liveQuery(async () => {
        let query: Collection<
          StoreRecord<StoreSchema>,
          number
        > = collection.toCollection();

        if (where && Object.keys(where).length > 0) {
          query = query.filter((item) => {
            return evaluateCondition(item.object, where);
          });
        }

        const results = await query.toArray();
        return results;
      });

      const subscription = observable.subscribe({
        next: (newResults: StoreRecord<StoreSchema>[]) => {
          setObjects((previousResults) => {
            if (previousResults.length !== newResults.length) return newResults;
            if (previousResults.length === 0) return previousResults;

            const previousObjectDict = Object.fromEntries(
              previousResults.map((o) => [o.id, o.object])
            );

            let contentChanged = false;

            for (const newRecord of newResults) {
              const oldObject = previousObjectDict[newRecord.id];
              if (!oldObject) {
                contentChanged = true;
                break;
              }
              if (!robustJsonCompare(newRecord.object, oldObject)) {
                contentChanged = true;
                break;
              }
            }
            return contentChanged ? newResults : previousResults;
          });
        },
        error: (err: any) => {
          console.error(`Error in liveQuery for ${name}:`, err);
          onError?.(err);
          setObjects([]);
        },
      });

      return () => {
        subscription.unsubscribe();
      };
    }, [name, JSON.stringify(where)]);

    return objects;
  };

  return {
    collection,
    addItem,
    findMany,
    findFirst,
    findLast,
    updateItem,
    updateAllWhere,
    updateManyByInternalId,
    updateManyByExternalKey,
    deleteItem,
    deleteMany,
    addMany,
    useRecords,
  };
}
