# Jupyter-like shell for the page: display, stdout and widget comms go to JS
import sys, json, base64
import js
from pyodide.ffi import to_js
import comm
from comm.base_comm import BaseComm
from traitlets import Type
from IPython.core.interactiveshell import InteractiveShell
from IPython.core.displaypub import DisplayPublisher
from IPython.core.displayhook import DisplayHook

_nb = js.ngsnb
_targets = []  # cell ids (int) or ipywidgets.Output


def _jsonable(data):
    return {k: base64.b64encode(v).decode() if isinstance(v, (bytes, bytearray)) else v
            for k, v in data.items()}


def _emit(out):
    t = _targets[-1] if _targets else -1
    if isinstance(t, int):
        _nb.output(t, json.dumps(out, default=str))
        return
    outs = [] if getattr(t, "_nb_wait", False) else list(t.outputs)
    t._nb_wait = False
    if (out["output_type"] == "stream" and outs and outs[-1].get("output_type") == "stream"
            and outs[-1]["name"] == out["name"]):
        outs[-1] = dict(outs[-1], text=outs[-1]["text"] + out["text"])
    else:
        outs.append(out)
    t.outputs = tuple(outs)


class _Stream:
    encoding = "utf-8"

    def __init__(self, name):
        self.name = name

    def write(self, s):
        if s:
            _emit({"output_type": "stream", "name": self.name, "text": s})
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False


class _Pub(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kw):
        _emit({"output_type": "display_data", "data": _jsonable(data), "metadata": metadata or {}})

    def clear_output(self, wait=False):
        t = _targets[-1] if _targets else -1
        if isinstance(t, int):
            _nb.clear(t, wait)
        elif wait:
            t._nb_wait = True
        else:
            t.outputs = ()


class _Hook(DisplayHook):
    def write_output_prompt(self):
        pass

    def write_format_data(self, format_dict, md_dict=None):
        _emit({"output_type": "execute_result", "data": _jsonable(format_dict), "metadata": md_dict or {}})


class Shell(InteractiveShell):
    display_pub_class = Type(_Pub)
    displayhook_class = Type(_Hook)


shell = Shell.instance()
try:
    shell.colors = "nocolor"
except Exception:
    pass
sys.stdout = _Stream("stdout")
sys.stderr = _Stream("stderr")


class _Comm(BaseComm):
    def publish_msg(self, msg_type, data=None, metadata=None, buffers=None, **keys):
        bufs = to_js([bytes(b) for b in buffers]) if buffers else None
        _nb.comm(msg_type, self.comm_id, json.dumps(data or {}, default=str), bufs)


comm.create_comm = lambda *a, **k: _Comm(*a, **k)

import ipywidgets


def _out_enter(self):
    _targets.append(self)


def _out_exit(self, etype, evalue, tb):
    try:
        if etype is not None:
            shell.showtraceback((etype, evalue, tb), tb_offset=0)
    finally:
        _targets.pop()
    return True


ipywidgets.Output.__enter__ = _out_enter
ipywidgets.Output.__exit__ = _out_exit


def recv(comm_id, data, buffers=None):
    c = comm.get_comm_manager().get_comm(comm_id)
    if c is None:
        return
    bufs = [memoryview(b.to_py()) for b in buffers] if buffers else []
    try:
        c.handle_msg({"content": {"comm_id": comm_id, "data": json.loads(data)}, "buffers": bufs, "metadata": {}})
    except Exception:
        shell.showtraceback()


def run(cell_id, code):
    _targets.append(cell_id)
    try:
        res = shell.run_cell(code, store_history=True)
    finally:
        _targets.pop()
    return json.dumps({"count": shell.execution_count - 1, "ok": bool(res.success)})
