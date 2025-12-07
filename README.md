# 🚀 react-idbstore

IndexedDB stores for React made easy.

### Overview

`react-idbstore` is a highly optimized, type-safe data factory designed to simplify persistent local storage management in React applications. It utilizes the robust Dexie.js library to wrap IndexedDB, providing a clean, reusable pattern for creating isolated, live-syncing data stores.

This factory eliminates boilerplate, ensures zero-conflict data storage, and provides high-performance rendering controls.

### Features

- **Isolated Stores**: Creates a unique, independent IndexedDB database for every store instance (`createIDBStore`), guaranteeing zero data interference between different application modules (e.g., 'contacts' vs. 'users').

- **Automatic Live Sync**: The `useRecords` hook uses Dexie's `liveQuery` to automatically update your components whenever data changes in the database.

- **Smart Performance**: Implements deep equality checks at the subscription level to prevent unnecessary React re-renders when the fetched data is content-identical to the previous state.

- **Advanced Querying**: Supports MongoDB-style `$and` and `$or` logical operators for complex client-side filtering.

- **Full Type Safety**: Built with TypeScript, ensuring all CRUD operations and query parameters (`WhereClause<T>`) strictly adhere to your defined schema.

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
