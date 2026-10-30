---
"@chatcops/widget": minor
---

`waitForConsent` holds the chat behind a notice until `ChatCops.setConsent(true)`. While it waits the widget uses no storage and calls no API; `setConsent(false)` closes the chat and removes what it saved. The notice has a button that calls `onConsentRequest`, and the script tag takes `data-wait-for-consent`.
