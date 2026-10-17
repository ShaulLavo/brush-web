//! A local executor: futures never move threads; only wake notifications are thread safe.
use futures::{
    future::LocalBoxFuture,
    task::{ArcWake, waker_ref},
};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
};

/// A host's race-safe idle primitive. `notify` must advance `epoch` before waking
/// the host; `park(observed)` may block ONLY if the epoch is still `observed`,
/// atomically with entering the wait. Browser hosts can instead use `drive` and
/// schedule another turn from `notify`; no blocking operation runs in a task.
pub trait IdleWakeSource: Send + Sync {
    fn epoch(&self) -> u64;
    fn notify(&self);
    fn park(&self, observed: u64);
}
struct ReadyQueue {
    ids: Mutex<VecDeque<usize>>,
    idle: Option<Arc<dyn IdleWakeSource>>,
}
struct TaskWake {
    id: usize,
    queued: AtomicBool,
    queue: Arc<ReadyQueue>,
}
impl ArcWake for TaskWake {
    fn wake_by_ref(this: &Arc<Self>) {
        if !this.queued.swap(true, Ordering::AcqRel) {
            this.queue.ids.lock().unwrap().push_back(this.id);
            if let Some(idle) = &this.queue.idle {
                idle.notify();
            }
        }
    }
}
struct Task {
    future: LocalBoxFuture<'static, ()>,
    wake: Arc<TaskWake>,
}
struct ExecutorState {
    tasks: RefCell<BTreeMap<usize, Task>>,
    next: Cell<usize>,
    queue: Arc<ReadyQueue>,
    driving: Cell<bool>,
}
#[derive(Clone)]
pub struct Executor(Rc<ExecutorState>);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drive {
    pub polls: usize,
    pub runnable: bool,
    pub pending: usize,
}
impl Default for Executor {
    fn default() -> Self {
        Self::new()
    }
}
impl Executor {
    pub fn new() -> Self {
        Self::make(None)
    }
    pub fn with_idle_source(idle: Arc<dyn IdleWakeSource>) -> Self {
        Self::make(Some(idle))
    }
    fn make(idle: Option<Arc<dyn IdleWakeSource>>) -> Self {
        Self(Rc::new(ExecutorState {
            tasks: RefCell::new(BTreeMap::new()),
            next: Cell::new(0),
            queue: Arc::new(ReadyQueue {
                ids: Mutex::new(VecDeque::new()),
                idle,
            }),
            driving: Cell::new(false),
        }))
    }
    pub fn spawn<T: Clone + 'static>(
        &self,
        future: impl Future<Output = T> + 'static,
    ) -> JoinHandle<T> {
        let result = Rc::new(RefCell::new(None));
        let event = Event::default();
        let handle = JoinHandle {
            result: result.clone(),
            event: event.clone(),
            waiting: None,
        };
        let id = self.0.next.get();
        self.0
            .next
            .set(id.checked_add(1).expect("task id exhausted"));
        let wake = Arc::new(TaskWake {
            id,
            queued: AtomicBool::new(false),
            queue: self.0.queue.clone(),
        });
        self.0.tasks.borrow_mut().insert(
            id,
            Task {
                wake: wake.clone(),
                future: Box::pin(async move {
                    *result.borrow_mut() = Some(future.await);
                    event.notify();
                }),
            },
        );
        ArcWake::wake_by_ref(&wake);
        handle
    }
    /// Nonblocking host turn, bounded even if tasks continually yield to themselves.
    pub fn drive(&self, max_polls: usize) -> Drive {
        assert!(
            !self.0.driving.replace(true),
            "executor drive is not reentrant"
        );
        struct Reset<'a>(&'a Cell<bool>);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }
        let _reset = Reset(&self.0.driving);
        let mut polls = 0;
        while polls < max_polls {
            let id = self.0.queue.ids.lock().unwrap().pop_front();
            let Some(id) = id else { break };
            let task = self.0.tasks.borrow_mut().remove(&id);
            let Some(mut task) = task else { continue };
            task.wake.queued.store(false, Ordering::Release);
            let waker = waker_ref(&task.wake);
            polls += 1;
            if task
                .future
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
            {
                self.0.tasks.borrow_mut().insert(id, task);
            }
        }
        Drive {
            polls,
            runnable: !self.0.queue.ids.lock().unwrap().is_empty(),
            pending: self.0.tasks.borrow().len(),
        }
    }
    /// Snapshot first, then check readiness: a notification anywhere in between
    /// the check and the host wait makes `park` return without sleeping.
    pub fn park_if_idle(&self) -> bool {
        let Some(idle) = &self.0.queue.idle else {
            return false;
        };
        let epoch = idle.epoch();
        if self.0.driving.get()
            || !self.0.queue.ids.lock().unwrap().is_empty()
            || self.0.tasks.borrow().is_empty()
        {
            return false;
        }
        idle.park(epoch);
        true
    }
}

pub struct JoinHandle<T> {
    result: Rc<RefCell<Option<T>>>,
    event: Event,
    waiting: Option<EventWait>,
}
impl<T> Clone for JoinHandle<T> {
    fn clone(&self) -> Self {
        Self {
            result: self.result.clone(),
            event: self.event.clone(),
            waiting: None,
        }
    }
}
impl<T> JoinHandle<T> {
    pub fn is_finished(&self) -> bool {
        self.result.borrow().is_some()
    }
}
impl<T: Clone> Future for JoinHandle<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let this = self.get_mut();
        loop {
            if this.waiting.is_none() {
                this.waiting = Some(this.event.listen());
            }
            if let Some(value) = this.result.borrow().as_ref().cloned() {
                this.waiting = None;
                return Poll::Ready(value);
            }
            if Pin::new(this.waiting.as_mut().unwrap())
                .poll(cx)
                .is_pending()
            {
                return Poll::Pending;
            }
            this.waiting = None;
        }
    }
}

#[derive(Default)]
struct EventState {
    epoch: u64,
    next: u64,
    waiters: BTreeMap<u64, Waker>,
}
/// Edge-triggered local notification with one removable registration per wait.
#[derive(Clone, Default)]
pub(crate) struct Event(Rc<RefCell<EventState>>);
impl Event {
    pub(crate) fn listen(&self) -> EventWait {
        EventWait {
            event: self.clone(),
            epoch: self.0.borrow().epoch,
            id: None,
        }
    }
    pub(crate) fn notify(&self) {
        let waiters = {
            let mut state = self.0.borrow_mut();
            state.epoch = state.epoch.wrapping_add(1);
            std::mem::take(&mut state.waiters)
        };
        for waker in waiters.into_values() {
            waker.wake();
        }
    }
    #[cfg(test)]
    pub(crate) fn waiter_count(&self) -> usize {
        self.0.borrow().waiters.len()
    }
}
pub(crate) struct EventWait {
    event: Event,
    epoch: u64,
    id: Option<u64>,
}
impl Future for EventWait {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let mut state = this.event.0.borrow_mut();
        if state.epoch != this.epoch {
            if let Some(id) = this.id.take() {
                state.waiters.remove(&id);
            }
            return Poll::Ready(());
        }
        let id = *this.id.get_or_insert_with(|| {
            let id = state.next;
            state.next = id.checked_add(1).expect("wait id exhausted");
            id
        });
        match state.waiters.get_mut(&id) {
            Some(waker) if waker.will_wake(cx.waker()) => {}
            _ => {
                state.waiters.insert(id, cx.waker().clone());
            }
        }
        Poll::Pending
    }
}
impl Drop for EventWait {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.event.0.borrow_mut().waiters.remove(&id);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}
impl std::error::Error for Cancelled {}
const HOST_PROBE_STRIDE: usize = 16;

struct CancelShared {
    flag: Cell<bool>,
    probe_remaining: Cell<usize>,
}

#[derive(Clone)]
pub struct Cancel {
    shared: Rc<CancelShared>,
    event: Event,
    probe: Option<Rc<dyn Fn() -> bool>>,
}
impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_probe(probe: Rc<dyn Fn() -> bool>) -> Self {
        Self {
            shared: Rc::new(CancelShared {
                flag: Cell::new(false),
                probe_remaining: Cell::new(0),
            }),
            event: Event::default(),
            probe: Some(probe),
        }
    }
    pub fn cancel(&self) {
        if !self.shared.flag.replace(true) {
            self.event.notify();
        }
    }
    pub(crate) fn without_probe(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            event: self.event.clone(),
            probe: None,
        }
    }
    pub fn is_cancelled(&self) -> bool {
        let shared = &*self.shared;
        if shared.flag.get() {
            return true;
        }
        let Some(probe) = &self.probe else {
            return false;
        };
        let remaining = shared.probe_remaining.get();
        if remaining != 0 {
            shared.probe_remaining.set(remaining - 1);
            return false;
        }
        shared.probe_remaining.set(HOST_PROBE_STRIDE - 1);
        if probe() {
            self.cancel();
        }
        shared.flag.get()
    }
    /// Probe the consuming host interrupt immediately at parser and runtime
    /// boundaries that must not wait for the ordinary work stride.
    pub fn probe_now(&self) -> bool {
        let shared = &*self.shared;
        if shared.flag.get() {
            return true;
        }
        if self.probe.as_ref().is_some_and(|probe| probe()) {
            self.cancel();
        }
        shared.flag.get()
    }
    pub async fn cancelled(&self) {
        let notification = self.event.listen();
        if !self.is_cancelled() {
            notification.await;
        }
    }
    /// Dropping this operation or losing the race removes both wait registrations.
    /// Cancellation wins ties and drops the inner future, unwinding its resources.
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> Result<T, Cancelled> {
        let cancelled = self.cancelled();
        futures::pin_mut!(cancelled, future);
        match futures::future::select(cancelled, future).await {
            futures::future::Either::Left(_) => Err(Cancelled),
            futures::future::Either::Right((value, _)) => Ok(value),
        }
    }
}

impl Default for Cancel {
    fn default() -> Self {
        Self {
            shared: Rc::new(CancelShared {
                flag: Cell::new(false),
                probe_remaining: Cell::new(0),
            }),
            event: Event::default(),
            probe: None,
        }
    }
}
/// Explicit work accounting; call on command dispatch, loop iterations and bounded
/// chunks of expansion/utility work, not just when I/O happens to block.
pub struct Budget {
    remaining: usize,
    quantum: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self::new(64)
    }
}
impl Budget {
    pub fn new(quantum: usize) -> Self {
        let quantum = quantum.max(1);
        Self {
            remaining: quantum,
            quantum,
        }
    }
    pub async fn checkpoint(&mut self, cancel: &Cancel) -> Result<(), Cancelled> {
        if cancel.is_cancelled() {
            return Err(Cancelled);
        }
        self.remaining -= 1;
        if self.remaining == 0 {
            self.remaining = self.quantum;
            yield_now().await;
        }
        if cancel.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }
}
pub async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{FutureExt, task::noop_waker};
    #[test]
    fn spawn_join_and_fair_budget() {
        let ex = Executor::new();
        let cancel = Cancel::new();
        let iterations = Rc::new(Cell::new(0));
        let n = iterations.clone();
        let c = cancel.clone();
        let busy = ex.spawn(async move {
            let mut budget = Budget::new(2);
            loop {
                if budget.checkpoint(&c).await.is_err() {
                    break;
                }
                n.set(n.get() + 1);
            }
        });
        let other = ex.spawn(async { 42 });
        let turn = ex.drive(4);
        assert!(turn.runnable);
        assert!(other.is_finished());
        assert!(iterations.get() > 0);
        cancel.cancel();
        ex.drive(8);
        assert!(busy.is_finished());
        assert_eq!(other.clone().now_or_never(), Some(42));
        assert_eq!(other.now_or_never(), Some(42));
    }
    #[test]
    fn registration_is_updated_and_removed_on_drop() {
        let cancel = Cancel::new();
        let mut wait = Box::pin(cancel.cancelled());
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..1000 {
            assert!(wait.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!(cancel.event.waiter_count(), 1);
        drop(wait);
        assert_eq!(cancel.event.waiter_count(), 0);
        let mut operation = Box::pin(cancel.run(futures::future::pending::<()>()));
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(Cancelled))
        );
        assert_eq!(cancel.event.waiter_count(), 0);
    }
    #[test]
    fn notification_before_registration_and_nested_spawns() {
        let event = Event::default();
        let wait = event.listen();
        event.notify();
        assert_eq!(wait.now_or_never(), Some(()));
        assert_eq!(event.waiter_count(), 0);
        let ex = Executor::new();
        let nested = ex.clone();
        let task = ex.spawn(async move { nested.spawn(async { 17 }).await });
        assert_eq!(ex.drive(8).pending, 0);
        assert_eq!(task.now_or_never(), Some(17));
    }
    #[test]
    fn shared_join_waits_unregister_independently() {
        let ex = Executor::new();
        let gate = Event::default();
        let wait = gate.listen();
        let mut first = ex.spawn(async move {
            wait.await;
            9
        });
        let mut second = first.clone();
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..100 {
            assert!(Pin::new(&mut first).poll(&mut cx).is_pending());
        }
        assert!(Pin::new(&mut second).poll(&mut cx).is_pending());
        assert_eq!(first.event.waiter_count(), 2);
        drop(second);
        assert_eq!(first.event.waiter_count(), 1);
        ex.drive(1);
        assert_eq!(ex.drive(100).polls, 0); // parked tasks are never polled speculatively
        gate.notify();
        ex.drive(8);
        assert_eq!(first.event.waiter_count(), 0);
        assert_eq!(first.now_or_never(), Some(9));
    }
    struct Idle {
        epoch: std::sync::atomic::AtomicU64,
        parks: std::sync::atomic::AtomicUsize,
    }
    impl IdleWakeSource for Idle {
        fn epoch(&self) -> u64 {
            self.epoch.load(Ordering::Acquire)
        }
        fn notify(&self) {
            self.epoch.fetch_add(1, Ordering::Release);
        }
        fn park(&self, observed: u64) {
            if observed == self.epoch() {
                self.parks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    #[test]
    fn host_parks_only_without_runnable_tasks_and_wakes_on_interrupt() {
        let idle = Arc::new(Idle {
            epoch: 0.into(),
            parks: 0.into(),
        });
        let ex = Executor::with_idle_source(idle.clone());
        let cancel = Cancel::new();
        let c = cancel.clone();
        let task = ex.spawn(async move { c.cancelled().await });
        assert!(!ex.park_if_idle());
        ex.drive(10);
        assert!(ex.park_if_idle());
        assert_eq!(idle.parks.load(Ordering::Relaxed), 1);
        let before = idle.epoch();
        cancel.cancel();
        assert!(idle.epoch() > before);
        assert!(!ex.park_if_idle());
        ex.drive(10);
        assert!(task.is_finished());
        assert!(!ex.park_if_idle());
    }
}
