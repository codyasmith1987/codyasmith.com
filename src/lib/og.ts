import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

type FontWeight = 400 | 500 | 600 | 700;

type FontSpec = {
  name: string;
  weight: FontWeight;
  url: string;
  data?: ArrayBuffer;
};

const FONTS: FontSpec[] = [
  {
    name: 'Inter',
    weight: 400,
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf',
  },
  {
    name: 'Inter',
    weight: 600,
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-600-normal.ttf',
  },
  {
    name: 'Instrument Serif',
    weight: 400,
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/instrument-serif@latest/latin-400-normal.ttf',
  },
  {
    name: 'JetBrains Mono',
    weight: 400,
    url: 'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.ttf',
  },
];

let fontsLoaded: Promise<FontSpec[]> | null = null;

async function loadFonts(): Promise<FontSpec[]> {
  if (fontsLoaded) return fontsLoaded;
  fontsLoaded = (async () => {
    await Promise.all(
      FONTS.map(async (f) => {
        if (f.data) return;
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`font fetch failed: ${f.url} ${res.status}`);
        f.data = await res.arrayBuffer();
      })
    );
    return FONTS;
  })();
  return fontsLoaded;
}

export type OgInput = {
  title: string;
  eyebrow: string;
  subtitle?: string;
  kicker?: string;
};

export async function renderOg(input: OgInput): Promise<Buffer> {
  const fonts = await loadFonts();

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#0a0a0a',
          padding: '72px 80px',
          fontFamily: 'Inter',
          color: '#f5f5f5',
          backgroundImage: 'radial-gradient(circle at 85% 0%, rgba(245, 158, 11, 0.10), transparent 55%)',
        },
        children: [
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: '12px' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontFamily: 'JetBrains Mono',
                      fontSize: '18px',
                      letterSpacing: '4px',
                      textTransform: 'uppercase',
                      color: '#fbbf24',
                    },
                    children: input.eyebrow,
                  },
                },
                input.kicker
                  ? {
                      type: 'div',
                      props: {
                        style: {
                          fontFamily: 'JetBrains Mono',
                          fontSize: '14px',
                          letterSpacing: '2px',
                          textTransform: 'uppercase',
                          color: '#a3a3a3',
                        },
                        children: input.kicker,
                      },
                    }
                  : null,
              ].filter(Boolean),
            },
          },
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: '24px' },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontFamily: 'Instrument Serif',
                      fontSize: '88px',
                      lineHeight: 1.05,
                      letterSpacing: '-0.015em',
                      color: '#f5f5f5',
                    },
                    children: input.title,
                  },
                },
                input.subtitle
                  ? {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '24px',
                          lineHeight: 1.5,
                          color: '#a3a3a3',
                          maxWidth: '1000px',
                        },
                        children: input.subtitle,
                      },
                    }
                  : null,
              ].filter(Boolean),
            },
          },
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                paddingTop: '24px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontFamily: 'Instrument Serif',
                      fontSize: '28px',
                      color: '#f5f5f5',
                    },
                    children: 'Cody Smith',
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontFamily: 'JetBrains Mono',
                      fontSize: '14px',
                      letterSpacing: '2px',
                      textTransform: 'uppercase',
                      color: '#737373',
                    },
                    children: 'codyasmith.com',
                  },
                },
              ],
            },
          },
        ],
      },
    } as Parameters<typeof satori>[0],
    {
      width: 1200,
      height: 630,
      fonts: fonts.map((f) => ({
        name: f.name,
        data: f.data!,
        weight: f.weight,
        style: 'normal',
      })),
    }
  );

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  return resvg.render().asPng();
}
