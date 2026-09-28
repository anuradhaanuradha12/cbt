-- ============================================================
-- Migration 006: repair the "hydrogen atom recoil speed" question
--
-- The bank holds this question twice and BOTH copies were damaged by the
-- original import:
--
--   * 6312307b…  double-encoded UTF-8 + flattened superscripts, so the UI
--                rendered option B as "2Ã—10-2 m s-1" and option A as "10-4".
--   * 7e49698d…  LaTeX survived, but the explanation lost a minus sign and
--                read "1.6 × 10^{19}" where the energy conversion needs
--                "1.6 × 10^{-19}" — a physically wrong value.
--
-- Physics (unchanged from the original, answer stays C):
--   ΔE = 13.6(1 − 1/25) = 13.056 eV
--   p  = E/c = (13.056 × 1.6e-19) / 3e8 ≈ 6.96e-27 kg m/s
--   v  = p/m = 6.96e-27 / 1.67e-27 ≈ 4 m/s
--
-- Note: SQLite treats backslash literally inside string literals, so the
-- LaTeX below needs no escaping.
--
-- Run (local):  wrangler d1 execute cbt-platform --local --file=src/db/migrations/006_fix_hydrogen_recoil_question.sql
-- Run (remote): wrangler d1 execute cbt-platform --file=src/db/migrations/006_fix_hydrogen_recoil_question.sql
-- ============================================================

UPDATE questions SET
  question_text = 'When a hydrogen atom emits a photon in going from \( \mathrm{n}=5 \) to \( \mathrm{n}=1 \), its recoil speed is almost',
  option_a = '\( 10^{-4} \mathrm{~m} / \mathrm{s} \)',
  option_b = '\( 2 \times 10^{-2} \mathrm{~m} / \mathrm{s} \)',
  option_c = '\( 4 \mathrm{~m} / \mathrm{s} \)',
  option_d = '\( 8 \times 10^{2} \mathrm{~m} / \mathrm{s} \)',
  correct_answer = 'C',
  explanation = 'Energy of the emitted photon \(=13.6\left(\frac{1}{1}-\frac{1}{25}\right) \mathrm{eV}=13.056 \mathrm{eV}\)
Photon momentum \(p=\frac{E}{c}=\frac{13.056 \times 1.6 \times 10^{-19}}{3 \times 10^{8}} \approx 6.96 \times 10^{-27} \mathrm{~kg} \mathrm{~m} / \mathrm{s}\)
By conservation of momentum the recoiling hydrogen atom carries the same momentum, so \(v=\frac{p}{m}=\frac{6.96 \times 10^{-27}}{1.67 \times 10^{-27}} \approx 4 \mathrm{~m} / \mathrm{s}\)'
WHERE id = '6312307b-31f8-49a4-b09c-fba850fd107d';

UPDATE questions SET
  question_text = 'When a hydrogen atom emits a photon in going from \( \mathrm{n}=5 \) to \( \mathrm{n}=1 \), its recoil speed is almost',
  option_a = '\( 10^{-4} \mathrm{~m} / \mathrm{s} \)',
  option_b = '\( 2 \times 10^{-2} \mathrm{~m} / \mathrm{s} \)',
  option_c = '\( 4 \mathrm{~m} / \mathrm{s} \)',
  option_d = '\( 8 \times 10^{2} \mathrm{~m} / \mathrm{s} \)',
  correct_answer = 'C',
  explanation = 'Energy of the emitted photon \(=13.6\left(\frac{1}{1}-\frac{1}{25}\right) \mathrm{eV}=13.056 \mathrm{eV}\)
Photon momentum \(p=\frac{E}{c}=\frac{13.056 \times 1.6 \times 10^{-19}}{3 \times 10^{8}} \approx 6.96 \times 10^{-27} \mathrm{~kg} \mathrm{~m} / \mathrm{s}\)
By conservation of momentum the recoiling hydrogen atom carries the same momentum, so \(v=\frac{p}{m}=\frac{6.96 \times 10^{-27}}{1.67 \times 10^{-27}} \approx 4 \mathrm{~m} / \mathrm{s}\)'
WHERE id = '7e49698d-c9eb-4d18-9259-73ff1196c938';
