import { useEffect } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useSubmissionsStore } from "../store/submissionsStore";

export function useReactions() {
  const upsertReaction = useSubmissionsStore((s) => s.upsertReaction);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "link_reactions"), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "removed") {
          const data = change.doc.data();
          if (data.url && typeof data.reaction_count === "number") {
            upsertReaction(data.url, data.reaction_count);
          }
        }
      });
    });
    return () => unsubscribe();
  }, [upsertReaction]);
}
