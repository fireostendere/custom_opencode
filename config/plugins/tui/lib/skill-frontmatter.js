import { load, JSON_SCHEMA } from "./vendor/js-yaml.mjs"

export function parseSkill(source) {
  if (typeof source !== "string" || source.length > 1_000_000)
    throw new Error("SKILL.md exceeds 1 MB")
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter")
  // Only scalar metadata is used; no custom YAML constructors are permitted.
  const metadata = load(match[1], { schema: JSON_SCHEMA, json: false })
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("frontmatter must be an object")
  if (typeof metadata.name !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(metadata.name))
    throw new Error("frontmatter name must be a valid Skill ID")
  if (typeof metadata.description !== "string" || !metadata.description.trim())
    throw new Error("frontmatter description is required")
  if (metadata.description.length > 8000)
    throw new Error("frontmatter description exceeds 8000 characters")
  const content = text.slice(match[0].length).trim()
  if (!content) throw new Error("skill instructions are required")
  return { name: metadata.name, description: metadata.description.trim(), content }
}
