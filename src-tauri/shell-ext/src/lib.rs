//! "Open with MusicTagCleaner" in the Windows 11 Explorer context menu.
//!
//! Windows 11's compact menu only lists `IExplorerCommand` handlers that come
//! from a packaged app; plain registry verbs land under "Show more options".
//! This DLL is that handler. It is registered by the sparse package in
//! `../windows/sparse/` (see `../windows/sparse/build.ps1`), which points at
//! the normal install folder, so the DLL must sit next to
//! `music-tag-cleaner.exe`.

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use windows::core::{implement, Error, Interface, Ref, Result, BOOL, GUID, HRESULT, PWSTR};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_NOTIMPL, E_POINTER, HMODULE,
    S_FALSE, S_OK,
};
use windows::Win32::System::Com::{IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray, SHStrDupW,
    ECF_DEFAULT, ECS_ENABLED, SIGDN_FILESYSPATH,
};

/// Must match the `Clsid` / `com:Class Id` in the sparse package manifest.
const CLSID_OPEN_COMMAND: GUID = GUID::from_u128(0x18a527bb_5fa8_4688_98fd_9db4d2ff7e7c);

const EXE_NAME: &str = "music-tag-cleaner.exe";

/// Keeps one launch's command line well under Windows' 32 767-char limit;
/// a bigger selection is split across launches, which the app's
/// single-instance hook merges into the already-open window.
const MAX_ARGS_CHARS: usize = 24_000;

static MODULE: AtomicIsize = AtomicIsize::new(0);
static OBJECTS: AtomicU32 = AtomicU32::new(0);
static LOCKS: AtomicU32 = AtomicU32::new(0);

fn install_dir() -> Option<PathBuf> {
    let mut buf = [0u16; 1024];
    let len = unsafe { GetModuleFileNameW(Some(HMODULE(MODULE.load(Ordering::Relaxed) as _)), &mut buf) };
    if len == 0 {
        return None;
    }
    let dll = PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize]));
    dll.parent().map(|p| p.to_path_buf())
}

fn exe_path() -> Option<PathBuf> {
    install_dir().map(|d| d.join(EXE_NAME))
}

fn co_str(s: &str) -> Result<PWSTR> {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SHStrDupW(windows::core::PCWSTR(wide.as_ptr())) }
}

fn selected_paths(items: &IShellItemArray) -> Result<Vec<String>> {
    let count = unsafe { items.GetCount()? };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let item = unsafe { items.GetItemAt(i)? };
        // Items without a file-system path (e.g. inside a zip) are skipped.
        if let Ok(p) = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) } {
            out.push(unsafe { p.to_string() }.unwrap_or_default());
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const c_void)) };
        }
    }
    out.retain(|p| !p.is_empty());
    Ok(out)
}

#[implement(IExplorerCommand)]
struct OpenCommand;

impl OpenCommand {
    fn new() -> Self {
        OBJECTS.fetch_add(1, Ordering::SeqCst);
        OpenCommand
    }
}

impl Drop for OpenCommand {
    fn drop(&mut self) {
        OBJECTS.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IExplorerCommand_Impl for OpenCommand_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        co_str("Open with MusicTagCleaner")
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        let exe = exe_path().ok_or_else(|| Error::from(E_NOTIMPL))?;
        co_str(&format!("{},0", exe.display()))
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(CLSID_OPEN_COMMAND)
    }

    fn GetState(&self, _items: Ref<IShellItemArray>, _ok_to_be_slow: BOOL) -> Result<u32> {
        // The manifest already limits the verb to audio extensions.
        Ok(ECS_ENABLED.0 as u32)
    }

    fn Invoke(&self, items: Ref<IShellItemArray>, _ctx: Ref<IBindCtx>) -> Result<()> {
        let items = items.ok()?;
        let exe = exe_path().ok_or_else(|| Error::from(E_POINTER))?;
        let paths = selected_paths(items)?;

        let mut batch: Vec<String> = Vec::new();
        let mut chars = 0usize;
        let launch = |batch: &[String]| {
            if !batch.is_empty() {
                let _ = Command::new(&exe).args(batch).spawn();
            }
        };
        for p in paths {
            if chars + p.len() + 3 > MAX_ARGS_CHARS {
                launch(&batch);
                batch.clear();
                chars = 0;
            }
            chars += p.len() + 3;
            batch.push(p);
        }
        launch(&batch);
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<windows::core::IUnknown>,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> Result<()> {
        if ppv.is_null() || riid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *ppv = std::ptr::null_mut() };
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let cmd: IExplorerCommand = OpenCommand::new().into();
        unsafe { cmd.query(riid, ppv).ok() }
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            LOCKS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[no_mangle]
pub extern "system" fn DllMain(module: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(module.0 as isize, Ordering::Relaxed);
    }
    true.into()
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    clsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if clsid.is_null() || riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    if *clsid != CLSID_OPEN_COMMAND {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory.into();
    factory.query(riid, ppv)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECTS.load(Ordering::SeqCst) == 0 && LOCKS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clsid_matches_manifest() {
        let manifest = include_str!("../../windows/sparse/AppxManifest.xml");
        let id = format!("{:?}", CLSID_OPEN_COMMAND).to_lowercase();
        assert!(manifest.to_lowercase().contains(&id), "manifest must use CLSID {id}");
    }
}
