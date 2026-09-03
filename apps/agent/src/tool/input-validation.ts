/** 判断未知值是否为普通 JSON 对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断对象键集合是否没有 Schema 之外的字段。 */
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** 判断未知值是否为非空字符串。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 判断可选值缺失或为非空字符串。 */
export function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

/** 判断可选值缺失或为指定闭区间内的安全整数。 */
export function isOptionalIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum)
  );
}
