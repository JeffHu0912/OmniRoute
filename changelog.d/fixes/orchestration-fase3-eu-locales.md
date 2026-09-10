- **fix(i18n):** the nine locales added with the EU-language batch (Greek, Estonian, Irish,
  Croatian, Lithuanian, Latvian, Maltese, Slovenian, Serbian) were missing the eleven
  Orchestration Canvas keys that Phase 3 introduced, so the compare-runs panel and the
  "no runs match these filters" empty state had no text in those languages. The coverage gate
  did not catch it: it enforces an 80% floor per locale, and nine missing keys out of ~13,000
  never approaches that. Translated for real in each language, calibrated against the wording
  each file already uses for "run", "filter" and "skill".
