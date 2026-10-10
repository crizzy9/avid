import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import type { LibraryRepository } from "../../../packages/core/src/repository";
import type { Book } from "../../../packages/core/src/types";

export function useImportedBooks(repo: LibraryRepository) {
  const [snapshot, setSnapshot] = useState<{ scope: string; books: Book[] }>({
    scope: repo.scope,
    books: [],
  });
  useEffect(() => {
    const subscription = liveQuery(() => repo.getImportedBooks()).subscribe({
      next: (books) => setSnapshot({ scope: repo.scope, books }),
      error: () => setSnapshot({ scope: repo.scope, books: [] }),
    });
    return () => subscription.unsubscribe();
  }, [repo]);
  return snapshot.scope === repo.scope ? snapshot.books : [];
}
