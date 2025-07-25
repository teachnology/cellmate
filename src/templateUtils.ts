/**
 * Replace template variables like {{audioBase64}}, {{apiKey}}, etc.
 */
export function applyTemplate(template: string, variables: Record<string, string | undefined>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = variables[key];
    if (value === undefined) {
      console.warn(`⚠️ Missing value for variable: {{${key}}}`);
      return `{{${key}}}`; // Keep original format
    }
    return value;
  });
}

/**
 * Extract value from nested object by path, e.g., getByPath(obj, 'a.b.c')
 */
export function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}
