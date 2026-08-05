# Time-format UI rollback

The initial organization-wide time-format display patch was rolled back from production after it caused repeated client-side rerendering across the HRMS.

The existing organization `time_format` value remains unchanged. A replacement implementation must format timestamps at render boundaries and must not observe or rewrite the entire document continuously.
