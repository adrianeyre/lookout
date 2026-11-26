/**
 * The Host's largest folders (the Host page's "Largest folders" Widget). Lookout walks each
 * real filesystem now and then and keeps only the result, in memory.
 */

/** How many folders the Widget shows. */
export const FOLDER_COUNT = 10;

/**
 * Never walked into: people's home folders hold their private files, and the scan is a
 * Widget, not a search (#107). Space under them is left out of every size.
 */
export const PRIVATE_FOLDERS = ['/home', '/root'] as const;

/** What bounds one scan (#109): past any of them it stops and says it is partial. */
export const FOLDER_SCAN_LIMITS = {
  /** Hard-linked files remembered, so each is counted once; past this they may count twice. */
  hardLinks: 1_000_000,
  /** Directory entries looked at, in all. */
  entries: 5_000_000,
  /** Folders deep below a filesystem's root. */
  depth: 256,
  /** How long one scan may run. */
  durationMs: 10 * 60_000,
} as const;

export interface FolderUsage {
  /** The folder on the Host, such as "/var/lib/docker/volumes". */
  path: string;
  /** Disk space it uses, counted in blocks like `du`, with hard links counted once. */
  bytes: number;
  /** The filesystem it is on, and that filesystem's size. */
  mountPoint: string;
  diskBytes: number;
  /** bytes / diskBytes, 0 to 100. */
  percentOfDisk: number;
}

export type FolderScanState = 'waiting' | 'scanning' | 'done' | 'failed';

export interface FolderScan {
  state: FolderScanState;
  /** The latest finished scan's heaviest folders, heaviest first; none of them inside another. */
  folders: FolderUsage[];
  /** When the latest scan started and finished, ms since the epoch. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Folders walked so far by the scan running now. */
  walked: number;
  /** Folders the latest scan could not read, which its sizes leave out. */
  unreadable: number;
  /** True when the latest scan stopped at one of FOLDER_SCAN_LIMITS, so sizes may be short. */
  partial: boolean;
  /** Why the latest scan failed. */
  error: string | null;
  /** When the next scheduled scan starts, or null when only "Scan now" starts one. */
  nextAt: number | null;
}

/** Where "Scan now" posts. */
export const FOLDER_SCAN_PATH = '/api/folders/scan';
