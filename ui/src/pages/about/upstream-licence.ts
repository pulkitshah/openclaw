// The upstream project's MIT notice, shown by the About page's Licences
// disclosure. Spec section 2b makes this the single place in the product where
// the upstream name may appear, and only when a reader opens the panel on
// purpose; `scripts/rebrand-apply.mjs` excludes this file from the brand
// rewrite and `ui/src/i18n/locales/brand.test.ts` asserts the notice is still
// here, so the exemption cannot go dead.
//
// Kept in its own module with no imports so the About page can `await import()`
// it on first open: the text must not reach the startup bundle, whose asset
// budget has only a few hundred bytes of headroom.
//
// Copied verbatim from the repository's LICENSE; `test/brand/*` and the about
// view test pin the copyright line, so an upstream LICENSE change surfaces
// here rather than silently drifting.
export const UPSTREAM_LICENCE_TITLE = "OpenClaw";

export const UPSTREAM_LICENCE_NOTICE = `MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
