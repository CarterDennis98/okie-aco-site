import { useState, type DragEvent } from "react";

/**
 * Reordering a list by dragging a row by its handle, or with its arrows: the set editor's
 * products, and the set arranger's sets.
 *
 * Native drag and drop. A row is only draggable while its handle is held, so text in the
 * row's inputs can still be selected with the mouse. Native dragging doesn't work on touch
 * screens, which is what the arrows are for -- the handle is hidden there.
 */
export function useReorder<T>(setItems: (update: (items: T[]) => T[]) => void, keys: string[]) {
  // The row whose handle is held, the row being dragged, and the row it's over.
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  /** Moves the item at `from` to `to`. Off either end, nothing moves. */
  const move = (from: number, to: number) =>
    setItems((current) => {
      if (to < 0 || to >= current.length || from === to) return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  /** For the handle: holding it is what makes its row draggable. */
  const handle = (key: string) => ({
    onPointerDown: () => setGrabbed(key),
    onPointerUp: () => setGrabbed(null),
  });

  /** For each row: dragging from it, and dropping onto it to take its place. */
  const row = (key: string, index: number) => ({
    draggable: grabbed === key,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      // Firefox starts no drag without some data.
      event.dataTransfer.setData("text/plain", key);
      setDragging(key);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragging) return;
      event.preventDefault();
      if (over !== key) setOver(key);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const from = dragging ? keys.indexOf(dragging) : -1;
      if (from >= 0) move(from, index);
      setDragging(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
      setGrabbed(null);
    },
  });

  return { move, handle, row, dragging, over };
}
