/** What the Host is: identity and how long it has been up. */
export interface HostOverview {
  hostname: string;
  /** Distribution name, for example "Debian GNU/Linux 13 (trixie)". */
  os: string;
  /** Kernel release, for example "6.12.0-1-amd64". */
  kernel: string;
  uptimeSeconds: number;
}

export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

export interface CpuMetrics {
  /** Overall usage %, or null on the first sample when there is no previous value. */
  usagePercent: number | null;
  /** Usage % per core, in core order. Null entries mean "no previous value yet". */
  perCore: (number | null)[];
  load: LoadAverage;
}

export interface SwapMetrics {
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  availableBytes: number;
  /** total − available. */
  usedBytes: number;
  usagePercent: number;
  /** Null when the Host has no swap. */
  swap: SwapMetrics | null;
}

export interface DiskFilesystem {
  mountPoint: string;
  device: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  /** Space available to unprivileged users, as `df` reports it. */
  freeBytes: number;
  /** used / (used + free), as `df` reports it. */
  usagePercent: number;
}

/** Throughput of one whole physical block device. */
export interface DiskIo {
  /** Kernel device name, for example "sda" or "nvme0n1". */
  device: string;
  /** Bytes/s since the previous sample, or null on the first sample. */
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
}

/** Throughput of one network interface. */
export interface NetworkInterface {
  name: string;
  /** Loopback or a Docker virtual interface (veth*), hidden by default (FR-11). */
  virtual: boolean;
  /** Bytes/s since the previous sample, or null on the first sample. */
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

/** One sample of every Host Metric, taken at `timestamp` (ms since the epoch). */
export interface HostSample {
  timestamp: number;
  overview: HostOverview;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskFilesystem[];
  diskIo: DiskIo[];
  network: NetworkInterface[];
}
