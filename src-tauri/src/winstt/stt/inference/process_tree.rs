//! A native runtime may itself be a process. Cancelling/crashing the inference
//! worker must not leave that process, its model RAM, or its port behind.
use std::process::Child;

pub(super) fn kill(child: &mut Child) {
    #[cfg(unix)]
    {
        // Workers are created as process-group leaders by Session::spawn.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

pub(super) fn exit() -> ! {
    #[cfg(unix)]
    unsafe {
        libc::kill(-libc::getpid(), libc::SIGKILL);
    }
    std::process::exit(0)
}

#[cfg(windows)]
pub(super) fn contain_descendants() -> Result<(), String> {
    use std::sync::OnceLock;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    static JOB: OnceLock<Result<usize, String>> = OnceLock::new();
    JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
        .and_then(|()| AssignProcessToJobObject(job, GetCurrentProcess()))
        {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(error.to_string());
        }
        // Keep this handle for the worker's lifetime. OS process teardown closes
        // it even for abort/driver faults, killing every inherited child job.
        Ok(job.0 as usize)
    })
    .as_ref()
    .map(|_| ())
    .map_err(Clone::clone)
}

#[cfg(not(windows))]
pub(super) fn contain_descendants() -> Result<(), String> {
    Ok(())
}
