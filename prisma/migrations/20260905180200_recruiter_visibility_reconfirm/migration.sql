-- Stage 18 review (M4): until this stage the recruiter-visibility preference
-- was recorded under the words "No recruiter features exist yet; this records
-- your choice for when they do." Stage 18 acts on the value - `visible` shows
-- a name, headline and city to every employer recruiter on the platform,
-- `anonymous` puts the résumé through scoring for any employer - and a
-- person who chose under the old words never agreed to that. Every existing
-- choice is reset to `hidden`; the new help text states exactly what each
-- value exposes, and the person chooses again.
UPDATE "CareerPreferences" SET "recruiterVisibility" = 'hidden' WHERE "recruiterVisibility" <> 'hidden';
