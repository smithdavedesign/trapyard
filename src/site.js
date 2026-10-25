// What search engines and link previews see: the public pages' titles and descriptions, their head
// tags (canonical URL, Open Graph, Twitter card, JSON-LD), robots.txt and sitemap.xml. Every URL is
// built from the configured public origin, never from the request's Host header.

import { LAUNCH_OFFER } from './payments.js';
import { esc } from './report.js';

export const REPO_URL = 'https://github.com/smithdavedesign/trapyard';
export const ISSUES_URL = `${REPO_URL}/issues`;

/** The share image every public page points at (drawn by siteImage() in share-image.js). */
export const SITE_IMAGE = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'trapyard: a free test range that tries to trick your AI agent, with four traps: a planted instruction, a leaked secret, an out-of-scope tool and an overspent budget.',
};

const TAGLINE = 'A free test range that tries to trick your AI agent with planted injections, fake tools and canary secrets.';

/** The pages in the sitemap, each with its own title and description. */
export const PUBLIC_PAGES = [
  {
    path: '/',
    title: 'trapyard: a free test range that tries to trick your AI agent',
    description:
      'Point your AI agent at a free test range of planted injections, fake tools and canary secrets, and see which traps it falls for.',
  },
  {
    path: '/privacy',
    title: 'trapyard: privacy',
    description:
      "What trapyard stores (your agent's requests to a run), what it doesn't (no cookies, no IP addresses), and the three events its beacon counts.",
  },
  {
    path: '/terms',
    title: 'trapyard: terms',
    description: 'Plain terms for trapyard: what a full report is and is not, its price, refunds, no warranty, and how to reach the seller.',
  },
];

export const publicPage = (path) => PUBLIC_PAGES.find((p) => p.path === path);

/**
 * The SoftwareApplication JSON-LD. The $149 Offer is there only while the Buy button is (a payment
 * link is set): structured data must match what the page sells. `<` is escaped so no text can close
 * the script element.
 */
export function jsonLd({ publicUrl, paymentLink }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'trapyard',
    description: TAGLINE,
    url: `${publicUrl}/`,
    image: `${publicUrl}${SITE_IMAGE.path}`,
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'Web',
  };
  if (paymentLink) {
    data.offers = {
      '@type': 'Offer',
      price: (LAUNCH_OFFER.cents / 100).toFixed(2),
      priceCurrency: 'USD',
      description: `The full report, paid once per agent: ${LAUNCH_OFFER.summary}.`,
      url: `${publicUrl}/#buy`,
      availability: 'https://schema.org/InStock',
    };
  }
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/**
 * Head tags for a page that can be shared: description, canonical URL, Open Graph and Twitter card,
 * and the JSON-LD. `image` defaults to the site's share image (a score card passes its own).
 */
export function shareHead(site, { url, title, description, image = null }) {
  const img = image ?? { url: `${site.publicUrl}${SITE_IMAGE.path}`, alt: SITE_IMAGE.alt };
  const tags = [
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="trapyard">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(img.url)}">`,
    `<meta property="og:image:width" content="${SITE_IMAGE.width}">`,
    `<meta property="og:image:height" content="${SITE_IMAGE.height}">`,
    `<meta property="og:image:alt" content="${esc(img.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(img.url)}">`,
    jsonLd(site),
  ];
  return tags.map((tag) => `\n${tag}`).join('');
}

/** Crawl everything public; keep crawlers off the range, private report links and the API. */
export function robotsTxt(publicUrl) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /r/',
    'Disallow: /report/',
    'Disallow: /api/',
    'Disallow: /runs',
    'Disallow: /checkout',
    '',
    `Sitemap: ${publicUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(publicUrl) {
  const urls = PUBLIC_PAGES.map((p) => `<url><loc>${esc(`${publicUrl}${p.path}`)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
