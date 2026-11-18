import { execFile } from "node:child_process";

const SERVICE_SUFFIX = ".com.metaphor.app";
const TARGET_ACCESS = `workos_access_token${SERVICE_SUFFIX}`;
const TARGET_REFRESH = `workos_refresh_token${SERVICE_SUFFIX}`;
const TARGET_EXPIRES = `workos_access_token_expires_at${SERVICE_SUFFIX}`;

const PS_CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MetaphorWinCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree([In] IntPtr cred);

    public static string ReadUtf16OrUtf8(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return null;
            throw new InvalidOperationException("CredReadW failed with Win32 error " + err);
        }
        try {
            CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
            if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return "";
            byte[] raw = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, raw, 0, raw.Length);
            bool looksUtf16 = raw.Length >= 2 && (raw.Length % 2 == 0) && raw[1] == 0;
            return (looksUtf16 ? Encoding.Unicode.GetString(raw) : Encoding.UTF8.GetString(raw)).Trim();
        } finally {
            CredFree(ptr);
        }
    }

    public static void WriteUtf16(string target, string userName, string secret) {
        byte[] bytes = Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = 1; // CRED_TYPE_GENERIC
            cred.TargetName = target;
            cred.UserName = userName;
            cred.CredentialBlobSize = (uint)bytes.Length;
            cred.CredentialBlob = blob;
            cred.Persist = 3; // CRED_PERSIST_ENTERPRISE (matches Rust keyring crate)
            if (!CredWrite(ref cred, 0)) {
                throw new InvalidOperationException("CredWriteW failed with Win32 error " + Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(blob);
        }
    }
}
"@

$mode = $env:METAPHOR_CRED_MODE
if ($mode -eq 'read') {
    $out = @{
        accessToken = [MetaphorWinCred]::ReadUtf16OrUtf8('${TARGET_ACCESS}')
        refreshToken = [MetaphorWinCred]::ReadUtf16OrUtf8('${TARGET_REFRESH}')
        expiresAt = [MetaphorWinCred]::ReadUtf16OrUtf8('${TARGET_EXPIRES}')
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Compress))
} elseif ($mode -eq 'write') {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($null -ne $payload.accessToken -and $payload.accessToken -ne '') {
        [MetaphorWinCred]::WriteUtf16('${TARGET_ACCESS}', 'workos_access_token', [string]$payload.accessToken)
    }
    if ($null -ne $payload.expiresAt -and $payload.expiresAt -ne '') {
        [MetaphorWinCred]::WriteUtf16('${TARGET_EXPIRES}', 'workos_access_token_expires_at', [string]$payload.expiresAt)
    }
    if ($null -ne $payload.refreshToken -and $payload.refreshToken -ne '') {
        [MetaphorWinCred]::WriteUtf16('${TARGET_REFRESH}', 'workos_refresh_token', [string]$payload.refreshToken)
    }
    [Console]::Out.Write('{"ok":true}')
} else {
    throw "Unsupported METAPHOR_CRED_MODE"
}
`;

const ENCODED_PS_SCRIPT = Buffer.from(PS_CRED_SCRIPT, "utf16le").toString("base64");

function runCredScript(mode, stdinText = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_PS_SCRIPT],
      {
        env: { ...process.env, METAPHOR_CRED_MODE: mode },
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const safeDetail = (stderr || "").trim().slice(0, 240) || `exit code ${err.code ?? "unknown"}`;
          reject(new Error(`Windows Credential Manager ${mode} failed (${safeDetail}).`));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

export function createWindowsKeychainStore() {
  if (process.platform !== "win32") {
    return null;
  }

  return {
    async readCredentials() {
      const stdout = await runCredScript("read");
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error("Windows Credential Manager returned malformed JSON metadata.");
      }
      return {
        accessToken: typeof parsed.accessToken === "string" && parsed.accessToken ? parsed.accessToken : null,
        refreshToken: typeof parsed.refreshToken === "string" && parsed.refreshToken ? parsed.refreshToken : null,
        expiresAt: typeof parsed.expiresAt === "string" && parsed.expiresAt ? parsed.expiresAt : null,
      };
    },

    async writeCredentials({ accessToken, refreshToken, expiresAt }) {
      await runCredScript(
        "write",
        JSON.stringify({
          accessToken: accessToken ?? null,
          refreshToken: refreshToken ?? null,
          expiresAt: expiresAt != null ? String(expiresAt) : null,
        }),
      );
    },
  };
}
