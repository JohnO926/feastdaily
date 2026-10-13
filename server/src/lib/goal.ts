/** Goal validity: 45..300 s in 15 s steps, or 300..2700 s in 60 s steps. */
export function isValidGoal(s: number): boolean {
  if (!Number.isInteger(s)) return false;
  if (s >= 45 && s <= 300) return s % 15 === 0;
  if (s > 300 && s <= 2700) return s % 60 === 0;
  return false;
}
