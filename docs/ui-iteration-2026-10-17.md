# UI iteration — 2026-10-17

- Desktop: help remains beside the title; theme/account controls align right. Mobile navigation and the bottom sidebar card remain intact.
- Announcements: ordinary close lasts for the current document only. The explicit opt-out stores only public announcement UUID/version under `voteproof-announcement-opt-outs`; a new version appears again. Old automatic-dismiss records are not treated as consent. The redundant security link is removed. Non-dismissible notices still honor their close policy and do not appear in auth/submission/Admin flows.
- The link button has its own switch; hiding it preserves its safe URL/label. New additive migration `0022_announcement_button_visibility.sql` defaults existing rows to visible. Backend validation, version CAS and audit include this flag. No Production migration was run.
- Every case workflow displays its primary authenticated proof thumbnail. IntersectionObserver gates requests to near-visible rows, with at most two in flight per list and cancellation on departure. Hover, touch long-press and Shift+Enter reuse the same RAM blob for enlargement; URLs are revoked on disposal. No public proof endpoint or storage was added.
- `GET /api/admin/overview` returns only the exact member count, including suspended accounts, to MFA-elevated staff. Reviewer access remains within the overview tab. It does not expose member records or private identities.
- Footer credits use the supplied reference screenshot and provided vote-site link; no external social profile was guessed. All existing About content now lives in a native dialog, with focus restoration and Escape; legacy `#about` opens it over Home.

Publication is GitHub Pages only, using the same frontend renderer and isolated fake transports. Production code/schema/D1/R2, Apps Script and the submission gate are unchanged. Production rollout still requires separately authorized code/schema integration, including 0020 → 0021 → 0022.
