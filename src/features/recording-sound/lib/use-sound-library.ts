import { useCallback } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
  soundLibraryAdd,
  soundLibraryPickAndAdd,
  soundLibraryRemove,
} from "@/shared/api/ipc-client";
import type { SoundLibraryEntry } from "@/shared/config/settings-schema";
import {
  defaultItem,
  entryToItem,
  isActive,
  type SoundLibraryItem,
} from "../model/recording-sound";

interface UseSoundLibraryOptions {
  defaultName: string;
  onError?: (message: string) => void;
}

interface UseSoundLibraryReturn {
  /** Whichever item is currently the recording sound. */
  activeItem: SoundLibraryItem;
  /** Active path: empty string means default. */
  activePath: string;
  /** Add a file from disk (browse + dialog). Returns the new entry on success. */
  addFromBrowse: () => Promise<SoundLibraryItem | null>;
  /** Add a file from a known source path (used by drag-drop). */
  addFromPath: (
    sourcePath: string,
    displayName?: string,
  ) => Promise<SoundLibraryItem | null>;
  /** Default (built-in) item — index 0 in `items`. */
  defaultEntry: SoundLibraryItem;
  /** Default + every uploaded entry in stable order. */
  items: SoundLibraryItem[];
  /** Delete a custom entry. Default cannot be deleted. */
  remove: (item: SoundLibraryItem) => Promise<void>;
  /** Rename a custom entry. No-op for the default. */
  rename: (id: string, newName: string) => void;
  /** Make the given item the active recording sound. */
  select: (item: SoundLibraryItem) => void;
}

interface DerivedLibrary {
  activeItem: SoundLibraryItem;
  activePath: string;
  defaultEntry: SoundLibraryItem;
  items: SoundLibraryItem[];
  library: SoundLibraryEntry[];
}

type GeneralSlice =
  | { recordingSoundLibrary?: SoundLibraryEntry[]; recordingSoundPath?: string }
  | undefined;

/** Read the two persisted recording-sound fields with their defaults. */
function readGeneral(general: GeneralSlice): {
  activePath: string;
  library: SoundLibraryEntry[];
} {
  return {
    activePath: general?.recordingSoundPath ?? "",
    library: general?.recordingSoundLibrary ?? [],
  };
}

/**
 * Pure projection of the persisted general-settings slice into the
 * picker's view model. Extracted so the hook body stays a flat sequence of
 * `useCallback`s with no derivation branching of its own.
 */
function deriveLibrary(
  general: GeneralSlice,
  defaultName: string,
): DerivedLibrary {
  const { activePath, library } = readGeneral(general);
  const defaultEntry = defaultItem(defaultName);
  const items = [defaultEntry, ...library.map(entryToItem)];
  const activeItem =
    items.find((it) => isActive(it, activePath)) ?? defaultEntry;
  return { activePath, library, defaultEntry, items, activeItem };
}

/**
 * Narrow a `soundLibraryAdd` result to either the entry or an error message.
 * Keeps the branch out of the `addFromPath` callback.
 */
function addedEntry(result: {
  ok: boolean;
  entry?: SoundLibraryEntry;
}): SoundLibraryEntry | null {
  return result.ok ? (result.entry ?? null) : null;
}

function readAddResult(result: {
  ok: boolean;
  entry?: SoundLibraryEntry;
  error?: string;
}): { entry: SoundLibraryEntry } | { error: string } {
  const entry = addedEntry(result);
  if (entry) {
    return { entry };
  }
  return { error: result.error ?? "Could not add sound" };
}

/** Error message for a failed remove, or null when the unlink succeeded. */
function removeErrorMessage(result: {
  ok: boolean;
  error?: string;
}): string | null {
  if (result.ok) {
    return null;
  }
  return result.error ?? "Could not delete sound file";
}

/**
 * Store patch that drops `item` from the library and collapses the active
 * path back to default when the removed item was the active one.
 */
function removalPatch(
  library: SoundLibraryEntry[],
  activePath: string,
  item: SoundLibraryItem,
): { recordingSoundLibrary: SoundLibraryEntry[]; recordingSoundPath: string } {
  return {
    recordingSoundLibrary: library.filter((e) => e.id !== item.id),
    recordingSoundPath: activePath === item.path ? "" : activePath,
  };
}

/** Decide the rename patch for an id; null name (after trim) means "no-op". */
function renamePatch(
  library: SoundLibraryEntry[],
  id: string,
  newName: string,
): SoundLibraryEntry[] | null {
  const trimmed = newName.trim();
  if (!trimmed) {
    return null;
  }
  return library.map((e) => (e.id === id ? { ...e, name: trimmed } : e));
}

export function useSoundLibrary({
  defaultName,
  onError,
}: UseSoundLibraryOptions): UseSoundLibraryReturn {
  const general = useSettingsStore((s) => s.settings.general);
  const update = useSettingsStore((s) => s.updateGeneralSettings);

  const { activePath, library, defaultEntry, items, activeItem } =
    deriveLibrary(general, defaultName);

  const handleError = useCallback(
    (message: string) => {
      if (onError) {
        onError(message);
      }
    },
    [onError],
  );

  const select = useCallback(
    (item: SoundLibraryItem) => {
      update({ recordingSoundPath: item.isDefault ? "" : item.path });
    },
    [update],
  );

  const addFromPath = useCallback(
    async (
      sourcePath: string,
      displayName?: string,
    ): Promise<SoundLibraryItem | null> => {
      const outcome = readAddResult(
        await soundLibraryAdd(sourcePath, displayName),
      );
      if ("error" in outcome) {
        handleError(outcome.error);
        return null;
      }
      const { entry } = outcome;
      update({
        recordingSoundLibrary: [...library, entry],
        recordingSoundPath: entry.path,
      });
      return entryToItem(entry);
    },
    [handleError, library, update],
  );

  const addFromBrowse =
    useCallback(async (): Promise<SoundLibraryItem | null> => {
      const result = await soundLibraryPickAndAdd();
      if (result.cancelled) {
        return null;
      }
      const outcome = readAddResult(result);
      if ("error" in outcome) {
        handleError(outcome.error);
        return null;
      }
      const { entry } = outcome;
      update({
        recordingSoundLibrary: [...library, entry],
        recordingSoundPath: entry.path,
      });
      return entryToItem(entry);
    }, [handleError, library, update]);

  const remove = useCallback(
    async (item: SoundLibraryItem): Promise<void> => {
      if (item.isDefault) {
        return;
      }
      // Pre-compute the patch so we both unlink the file AND collapse the
      // active path back to default in a single store update if necessary.
      update(removalPatch(library, activePath, item));
      const result = await soundLibraryRemove(item.path);
      // File unlink may fail — the store is already updated, but surface
      // the error so the user knows the file is still on disk.
      const message = removeErrorMessage(result);
      if (message) {
        handleError(message);
      }
    },
    [activePath, handleError, library, update],
  );

  const rename = useCallback(
    (id: string, newName: string) => {
      const nextLibrary = renamePatch(library, id, newName);
      if (nextLibrary) {
        update({ recordingSoundLibrary: nextLibrary });
      }
    },
    [library, update],
  );

  return {
    items,
    defaultEntry,
    activeItem,
    activePath,
    select,
    addFromBrowse,
    addFromPath,
    remove,
    rename,
  };
}
