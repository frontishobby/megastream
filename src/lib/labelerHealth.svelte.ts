import { fetchLabelerHealth, type LabelerHealth } from './labeler';

// Last known Scene AI state, shared by the header pill (which polls it) and
// anything that only shows Scene AI features while the server is up.
// value: undefined = first probe in flight, null = offline.
export const labelerHealth = $state<{
  value: LabelerHealth | null | undefined;
  checking: boolean;
}>({ value: undefined, checking: false });

export async function refreshLabelerHealth(): Promise<void> {
  if (labelerHealth.checking) return;
  labelerHealth.checking = true;
  try {
    labelerHealth.value = await fetchLabelerHealth();
  } finally {
    labelerHealth.checking = false;
  }
}
