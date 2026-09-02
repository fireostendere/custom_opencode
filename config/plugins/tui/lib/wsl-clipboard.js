import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { release as osRelease, tmpdir } from "node:os"
import { join } from "node:path"

export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024
const MAX_PROTOCOL_BYTES = Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4 + 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function isWSL({ platform = process.platform, env = process.env, release = osRelease() } = {}) {
  if (platform !== "linux") return false
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV) || /microsoft|wsl/i.test(release)
}

function decodeBase64(payload) {
  if (!payload || payload.length > MAX_PROTOCOL_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    throw new Error("Invalid clipboard payload")
  }
  const bytes = Buffer.from(payload, "base64")
  if (bytes.length > MAX_CLIPBOARD_BYTES || bytes.toString("base64") !== payload) {
    throw new Error("Invalid clipboard payload")
  }
  return bytes
}

export function parseClipboardProtocol(output) {
  const text = Buffer.isBuffer(output) ? output.toString("ascii") : String(output ?? "")
  if (Buffer.byteLength(text, "ascii") > MAX_PROTOCOL_BYTES) throw new Error("Clipboard protocol is too large")
  const newline = text.indexOf("\n")
  const type = newline === -1 ? text.replace(/\r$/, "") : text.slice(0, newline).replace(/\r$/, "")
  const payload = newline === -1 ? "" : text.slice(newline + 1).replace(/\r?\n$/, "")

  if (type === "empty") {
    if (payload) throw new Error("Invalid empty clipboard payload")
    return { kind: "empty", bytes: Buffer.alloc(0) }
  }
  if (type !== "image/png" && type !== "text/plain") throw new Error("Unknown clipboard protocol type")
  if (payload.includes("\n") || payload.includes("\r")) throw new Error("Invalid clipboard payload")
  const bytes = decodeBase64(payload)
  if (type === "image/png") {
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error("Clipboard image is not a PNG")
    }
    return { kind: "image", bytes }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("Clipboard text is not UTF-8")
  }
  return { kind: "text", bytes }
}

const POWERSHELL_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::ASCII; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; try { $image=[Windows.Forms.Clipboard]::GetImage(); if ($null -ne $image) { $stream=New-Object IO.MemoryStream; $image.Save($stream,[Drawing.Imaging.ImageFormat]::Png); Write-Output 'image/png'; [Console]::Write([Convert]::ToBase64String($stream.ToArray())); exit 0 }; if ([Windows.Forms.Clipboard]::ContainsText([Windows.Forms.TextDataFormat]::UnicodeText)) { $value=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText); Write-Output 'text/plain'; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))); exit 0 }; Write-Output 'empty' } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`

export async function readWindowsClipboard({ spawnImpl = spawn, timeoutMs = 5000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", POWERSHELL_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error("Windows clipboard read timed out"))
    }, timeoutMs)
    child.once("error", (error) => finish(error))
    child.stdout.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_PROTOCOL_BYTES) {
        child.kill()
        finish(new Error("Windows clipboard output is too large"))
      } else chunks.push(chunk)
    })
    child.once("close", (code) => {
      if (settled) return
      if (code !== 0) return finish(new Error("Windows clipboard read failed"))
      try {
        finish(null, parseClipboardProtocol(Buffer.concat(chunks)))
      } catch (error) {
        finish(error)
      }
    })
  })
}

export async function materializeClipboardPNG(bytes) {
  const image = Buffer.from(bytes)
  if (image.length > MAX_CLIPBOARD_BYTES || image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Clipboard image is not a PNG")
  }
  const directory = await mkdtemp(join(tmpdir(), "custom-opencode-clipboard-"))
  await chmod(directory, 0o700)
  const path = join(directory, "clipboard.png")
  try {
    await writeFile(path, image, { mode: 0o600, flag: "wx" })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) }
}
