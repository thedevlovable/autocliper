---
name: SEO route rendering
description: Crawlable sitemap pages in the Vite + Express application require route-specific static HTML before React loads.
---

Sitemap-listed public routes must return a page-specific title, description, self-referential canonical URL, social metadata, and meaningful body content in their raw HTTP response. Do not rely on React effects to change document metadata after the SPA starts.

**Why:** Search crawlers, link preview bots, and AI agents may only inspect the initial HTML response. A shared SPA shell makes all routes appear canonicalized to the homepage and prevents inner-page content from being indexed reliably.

**How to apply:** When adding an indexable public route, build a Vite HTML entry with a static fallback inside the root element and serve that file explicitly before the Express SPA fallback. Verify the built server response for every sitemap URL with a non-JavaScript HTTP request.