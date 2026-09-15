/**
 * Help examples shown by the Browser CLI root command.
 */
/** Core Browser CLI examples for lifecycle and inspection commands. */
export const browserCoreExamples = [
  "openclaw browser status",
  "openclaw browser start",
  "openclaw browser start --headless",
  "openclaw browser stop",
  "openclaw browser tabs",
  "vasudev browser open https://example.com",
  "openclaw browser focus abcd1234",
  "openclaw browser close abcd1234",
  "openclaw browser screenshot",
  "openclaw browser screenshot --full-page",
  "vasudev browser screenshot --ref 12",
  "openclaw browser snapshot",
  "vasudev browser snapshot --format aria --limit 200",
  "openclaw browser snapshot --efficient",
  "openclaw browser snapshot --labels",
];

/** Browser CLI examples for interaction/action commands. */
export const browserActionExamples = [
  "vasudev browser navigate https://example.com",
  "vasudev browser resize 1280 720",
  "vasudev browser click 12 --double",
  "vasudev browser click-coords 120 340",
  'vasudev browser type 23 "hello" --submit',
  "vasudev browser press Enter",
  "vasudev browser hover 44",
  "vasudev browser drag 10 11",
  "vasudev browser select 9 OptionA OptionB",
  "vasudev browser upload /tmp/openclaw/uploads/file.pdf",
  "vasudev browser upload media://inbound/file.pdf",
  'vasudev browser fill --fields \'[{"ref":"1","value":"Ada"}]\'',
  "openclaw browser dialog --accept",
  'vasudev browser wait --text "Done"',
  "vasudev browser evaluate --fn '(el) => el.textContent' --ref 7",
  "vasudev browser evaluate --fn 'const title = document.title; return title;'",
  "openclaw browser console --level error",
  "openclaw browser pdf",
  "vasudev browser batch --actions-file plan.json",
  'vasudev browser batch --actions \'[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]\'',
  "vasudev browser batch --actions-file plan.json --continue",
];
