<script lang="ts">
  // Minimal stick-figure glyphs for the fixed position label set. Abstract
  // on purpose: heads are dots, bodies are strokes — just enough shape to
  // tell labels apart at chip size. Unknown labels fall back to text.
  let { position, size = 15 } = $props<{ position: string; size?: number }>();

  interface Glyph {
    /** filled dots (heads) — cx, cy, r */
    dots?: Array<[number, number, number]>;
    /** stroked circles — cx, cy, r */
    rings?: Array<[number, number, number]>;
    paths: string[];
  }

  const GLYPHS: Record<string, Glyph> = {
    // one lying flat, one arched above
    missionary: {
      dots: [
        [4.5, 17.5, 2],
        [6, 9.5, 2],
      ],
      paths: ['M8 17.5 H21', 'M9 10.5 L20 14.5'],
    },
    // one on all fours, one kneeling behind
    doggy: {
      dots: [
        [4.5, 10, 2],
        [19.5, 6.5, 2],
      ],
      paths: [
        'M7 10.5 H14.5',
        'M8.5 10.5 V16',
        'M13.5 10.5 V16',
        'M19.5 8.5 V13.5',
        'M19.5 13.5 L16.5 16.5',
      ],
    },
    // one lying, one straddling upright (leaning toward the head end)
    cowgirl: {
      dots: [
        [4.5, 18, 2],
        [11.5, 6.5, 2],
      ],
      paths: ['M8 18 H21', 'M11.5 8.5 V13', 'M11.5 13 L8.5 16', 'M11.5 13 L14.5 16'],
    },
    // one lying, rider facing (and leaning) the other way
    'reverse-cowgirl': {
      dots: [
        [4.5, 18, 2],
        [17, 7, 2],
      ],
      paths: ['M8 18 H21', 'M16.5 9 L15 13', 'M15 13 L12 15.5', 'M15 13 L18 16'],
    },
    // two nested side-lying figures
    spooning: {
      dots: [
        [4, 10, 2],
        [9, 6, 2],
      ],
      paths: ['M6.5 10 H13', 'M13 10 L10 16.5', 'M11.5 6 H18', 'M18 6 L15 12.5'],
    },
    // two upright, one leg lifted
    standing: {
      dots: [
        [8.5, 5.5, 2],
        [15.5, 5.5, 2],
      ],
      paths: ['M8.5 7.5 V17.5', 'M15.5 7.5 V17.5', 'M15.5 12 L11 15.5'],
    },
    // one upright, one kneeling at hip height
    oral: {
      dots: [
        [16, 5.5, 2],
        [9, 11, 2],
      ],
      paths: ['M16 7.5 V17.5', 'M9 13 V16', 'M9 16 L6 18.5', 'M11 12 L14 12.5'],
    },
    // column between two circles
    paizuri: {
      rings: [
        [9, 13, 2.6],
        [15, 13, 2.6],
      ],
      paths: ['M12 5.5 V16.5'],
    },
    // grip ring on a column
    handjob: {
      rings: [[13, 14, 3.6]],
      paths: ['M13 4.5 V10.5'],
    },
    // single reclining figure
    solo: {
      dots: [[6, 8, 2]],
      paths: ['M8.5 9.5 L17 13.5', 'M17 13.5 L14 17.5', 'M11 15.5 L13.5 12.5'],
    },
  };

  const glyph = $derived(GLYPHS[position] ?? null);
</script>

{#if glyph}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label={position}
  >
    {#each glyph.dots ?? [] as [cx, cy, r]}
      <circle {cx} {cy} {r} fill="currentColor" stroke="none" />
    {/each}
    {#each glyph.rings ?? [] as [cx, cy, r]}
      <circle {cx} {cy} {r} />
    {/each}
    {#each glyph.paths as d}
      <path {d} />
    {/each}
  </svg>
{:else}
  <span class="uppercase tracking-wide text-[10px]">{position}</span>
{/if}
