import { useI18n } from "../../../packages/i18n/src";
import { useEffect, useState } from "react";
import { Check, LoaderCircle, Plus } from "lucide-react";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Collection } from "../../../packages/core/src/types";

export function BookCollections({
  client,
  bookId,
}: {
  client: BookOrbitClient;
  bookId: string;
}) {
  const { t, locale, setLocale } = useI18n();

  const [collections, setCollections] = useState<Collection[]>([]);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    client
      .getBookCollections(bookId)
      .then((value) => {
        if (active) setCollections(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [client, bookId]);
  async function toggle(collection: Collection) {
    setBusy(collection.id);
    setError("");
    try {
      const selected = collection.bookIds.includes(bookId);
      if (selected) await client.removeCollectionBooks(collection.id, [bookId]);
      else await client.addCollectionBooks(collection.id, [bookId]);
      setCollections((previous) =>
        previous.map((c) =>
          c.id === collection.id
            ? { ...c, bookIds: selected ? [] : [bookId] }
            : c,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("collections.failed"));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="detail-collections">
      <h3>{t("collections.shelves")}</h3>
      {busy === "load" ? (
        <p className="loading-label">
          <LoaderCircle className="spin" size={15} />
          {t("collections.loading")}
        </p>
      ) : (
        <div className="collection-memberships">
          {collections.map((collection) => (
            <button
              key={collection.id}
              className="secondary-button"
              disabled={client.readOnly || !!busy}
              aria-pressed={collection.bookIds.includes(bookId)}
              onClick={() => void toggle(collection)}
            >
              {busy === collection.id ? (
                <LoaderCircle className="spin" size={14} />
              ) : collection.bookIds.includes(bookId) ? (
                <Check size={14} />
              ) : (
                <Plus size={14} />
              )}{" "}
              {collection.name}
            </button>
          ))}
        </div>
      )}
      {!busy && !collections.length && (
        <p className="muted">{t("collections.none")}</p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
