# 🚀 react-idbstore

IndexedDB stores for React made easy.

### Overview

`react-idbstore` is a highly optimized, type-safe data factory designed to simplify persistent local storage management in React applications. It utilizes the robust Dexie.js library to wrap IndexedDB, providing a clean, reusable pattern for creating isolated, live-syncing data stores.

This factory eliminates boilerplate, ensures zero-conflict data storage, and provides high-performance rendering controls.

### Features

- **Isolated Stores**: Creates a unique, independent IndexedDB database for every store instance (`createIDBStore`), guaranteeing zero data interference between different application modules (e.g., 'contacts' vs. 'users').

- **Automatic Live Sync & Tab Sync**: The `useRecords` hook uses Dexie's `liveQuery` to automatically update your components whenever data changes in the database, including **real-time synchronization across multiple browser tabs or windows** (Tab Sync).

- **Powerful Imperative Reads**: Supports fast, single-use data fetching with **`findFirst`**, **`findLast`**, and **`findMany`** for scenarios outside of React components.

- **Smart Performance**: Implements deep equality checks at the subscription level to prevent unnecessary React re-renders when the fetched data is content-identical to the previous state.

- **Advanced Querying**: Supports MongoDB-style `$and` and `$or` logical operators for complex client-side filtering.

- **Full Type Safety**: Built with TypeScript, ensuring all CRUD operations and query parameters (`WhereClause<T>`) strictly adhere to your defined schema.

### Data Relationships & The Isolation Trade-Off ⚠️

The architecture of `react-idbstore` prioritizes **isolation and reusability** by creating a separate IndexedDB database for every store instance.

##### No Native Joins

Because each store is a physically separate database, **native database-level joins (like SQL JOINs or Dexie’s link queries) are not possible**. IndexedDB transactions cannot span across multiple databases.

This is a conscious trade-off that offers significant benefits:

| Con (Trade-Off)             | Pro (Benefit)                                                                                                                          |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| **No Native Joins**         | **Absolute Data Isolation:** Zero risk of schema or data conflicts between application modules.                                        |
| **Multiple Reads Required** | **Modular Simplicity:** Easy schema maintenance and component-level fetching (only fetch the related data you need, when you need it). |

#### Handling Related Data (Client-Side Joining)

To link data, fetch related records in parallel and combine them in your component's logic.

**Example: Linking a Post and its Author**

```tsx
import { PostStore, UserStore } from './stores';

function PostDetail({ postId }) {
  // 1. Fetch the primary record
  const post = PostStore.useRecords({ where: { id: postId } })?.[0];

  // 2. Fetch the related record using the FK (post.object.authorId)
  const author = UserStore.useRecords({ where: { id: post?.object.authorId } })?.[0];

  return (
    // ... render combined data ...
  );
}

```

### Installation & Setup

##### Start by installing `react-idbstore`:

```
bun add react-idbstore
```

(You can use npm or yarn too)

##### Define Your Stores

```ts
// stores.ts

import { createIDBStore } from "react-idbstore";

interface TodoItem {
  title: string;
  completed: boolean;
  priority: "low" | "high";
  dueDate: number;
}

// Creates the isolated 'todos' database
export const TodoStore = createIDBStore<TodoItem>({ name: "todos" });

// Creates the isolated 'logs' database
export const LogStore = createIDBStore<{ timestamp: number; message: string }>({
  name: "app_logs",
});
```

### Usage

##### Live Querying (`useRecords`)

The hook returns an array of records `{ id: number, object: StoreSchema }`.

```tsx
import React from "react";
import { TodoStore } from "./stores";

function TodoList() {
  // Fetches items where (completed === false) AND (priority === 'high')
  const highPriorityTodos = TodoStore.useRecords({
    where: { completed: false, priority: "high" },
  });

  if (!highPriorityTodos.length) return <div>Loading...</div>;

  return (
    <ul>
      {highPriorityTodos.map((record) => (
        <li key={record.id}>
          {/* Access the payload via .object */}
          {record.object.title}
        </li>
      ))}
    </ul>
  );
}
```

##### Complex Filtering (`$and` / `$or`)

Filter logic can be combined for powerful, stable client-side queries.

```tsx
// Example: Show tasks that are NOT completed OR are overdue (dueDate < current time)
const urgentTasks = TodoStore.useRecords({
  where: {
    $or: [
      { completed: false },
      { dueDate: Date.now() }, // Note: Equality checks are used here. For range queries, use custom filter.
    ],
  },
});

// Example: Show tasks that are high priority AND (uncompleted OR overdue)
const criticalTasks = TodoStore.useRecords({
  where: {
    $and: [
      { priority: "high" },
      {
        $or: [{ completed: false }, { dueDate: Date.now() }],
      },
    ],
  },
});
```

##### CRUD Operations

All write operations return a Promise and should be wrapped in try/catch for robust error handling.

| Operation        | Usage                                                 | Notes                                                           |
| :--------------- | :---------------------------------------------------- | :-------------------------------------------------------------- |
| **`addItem`**    | `await TodoStore.addItem({ title: 'New' })`           | Returns the `id` of the new item.                               |
| **`addMany`**    | `await TodoStore.addMany([item1, item2])`             | High-performance bulk insert. Returns the key of the last item. |
| **`updateItem`** | `await TodoStore.updateItem(id, { completed: true })` | Supports partial object updates or function-based updates.      |
| **`deleteItem`** | `await TodoStore.deleteItem(id)`                      | Deletes a single record by primary key.                         |
| **`deleteMany`** | `await TodoStore.deleteMany([id1, id2])`              | High-performance bulk delete.                                   |

### API Reference

The `createIDBStore<StoreSchema>(definition)` factory returns an object with the following interface:

##### I. Read Hook

| Function         | Signature                | Description                                                              |
| :--------------- | :----------------------- | :----------------------------------------------------------------------- |
| **`useRecords`** | `({ where?, onError? })` | Live subscribes to the collection. Returns `StoreRecord<StoreSchema>[]`. |

##### II. Query Types

| Type                 | Structure                                                | Description                                                    |
| :------------------- | :------------------------------------------------------- | :------------------------------------------------------------- |
| **`WhereClause<T>`** | `{ key: value }`, `{ $and: [...] }`, or `{ $or: [...] }` | The strongly typed query object used in the `useRecords` hook. |

### API Reference

The `createIDBStore<StoreSchema>(definition)` factory returns an object with the following interface:

##### I. Read Hook (Reactive)

| Function         | Signature                | Description                                                                                                                                                                  |
| :--------------- | :----------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`useRecords`** | `({ where?, onError? })` | **Live Hook:** Returns `StoreRecord<StoreSchema>[]`. Subscribes to collection changes, applies filtering, and uses smart comparison to prevent unnecessary React re-renders. |

##### II. Read Operations (Async)

| Function        | Signature                 | Description                                                                                                                   |
| :-------------- | :------------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| **`findFirst`** | `(where: WhereClause<T>)` | Returns the **first** record (lowest ID) matching the criteria. Optimized with a forward cursor, stopping on the first match. |
| **`findLast`**  | `(where: WhereClause<T>)` | Returns the **last** record (highest ID) matching the criteria. Optimized with a reverse cursor, stopping on the first match. |
| **`findMany`**  | `(where: WhereClause<T>)` | Returns **all** records matching the criteria. Useful for imperative data fetching outside of components.                     |

##### III. Write Operations (Async)

| Operation        | Signature                                                     | Notes                                                                 |
| :--------------- | :------------------------------------------------------------ | :-------------------------------------------------------------------- |
| **`addItem`**    | `(item: T)`                                                   | Adds a single new item. Returns the new item's `id`.                  |
| **`addMany`**    | `(items: T[])`                                                | High-performance bulk insert. Returns the key of the last added item. |
| **`updateItem`** | `(id: number, update: Partial<T> \| (prev: T) => Partial<T>)` | Supports partial object updates or function-based state transitions.  |
| **`deleteItem`** | `(id: number)`                                                | Deletes a single record by primary key.                               |
| **`deleteMany`** | `(ids: number[])`                                             | High-performance bulk delete.                                         |

##### IV. Query Types

| Type                 | Structure                                                | Description                                                                             |
| :------------------- | :------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| **`WhereClause<T>`** | `{ key: value }`, `{ $and: [...] }`, or `{ $or: [...] }` | The strongly typed query object used in the `useRecords` and imperative read functions. |
