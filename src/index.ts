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

type StoreRecord<StoreSchema> = {
  id: number;
  object: StoreSchema;
};

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
      await collection.bulkDelete(ids);
    } catch (err) {
      console.error(
        `Failed to bulk delete items with ids ${ids.join(",")}:`,
        err
      );
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
      console.error(`Failed to update item with id ${id}`);
      throw err;
    }
  };

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
    addItem,
    updateItem,
    deleteItem,
    deleteMany,
    addMany,
    useRecords,
  };
}
