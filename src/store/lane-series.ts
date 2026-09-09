/** Lane chart values retain the sample timestamp and each pressure resource. */
export interface LaneSample {
  time: number;
  cpu: number | null;
  rss: number | null;
  pressure: number | null;
  memoryPressure: number | null;
  ioPressure: number | null;
}
