# Silo legal pages

Published at https://cuang.dev/projects/silo/privacy/ and /terms/ (Indonesian: /privacy/id/, /terms/id/;
the Indonesian versions prevail). Host copy on docker-host: /home/agent/orca/learnings/projects-cuang-dev/html/projects/silo/
(then `docker cp` into projects-cuang-nginx).

When the Terms change: update these files, publish them, and bump `TERMS_VERSION` in src/services/terms.ts so the
app asks users to agree again (changed terms apply only once accepted, UU 8/1999 Art. 18).
When data handling changes: update the Privacy Policy before the app version that changes it ships (UU PDP Art. 21(2)),
and keep the in-app Privacy screen (src/screens/PrivacyScreen.tsx) consistent. RESEARCH.md lists the sources.
