"""Loads the spike page in the system WebKitGTK (6.0) and prints its report.

Run under a private X server: xvfb-run -a python3 webkit_gi.py URL
"""

import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import GLib, Gtk, WebKit  # noqa: E402

URL = sys.argv[1]
TIMEOUT_S = int(sys.argv[2]) if len(sys.argv) > 2 else 150


def main():
    app = Gtk.Application(application_id=None)
    result = {"report": "null"}

    def on_activate(app):
        window = Gtk.ApplicationWindow(application=app)
        view = WebKit.WebView()
        window.set_child(view)
        window.present()
        view.load_uri(URL)

        def done(view, task, _data):
            try:
                value = view.evaluate_javascript_finish(task).to_string()
            except GLib.Error:
                return
            if value != "null":
                result["report"] = value
                app.quit()

        def poll():
            view.evaluate_javascript(
                "JSON.stringify(window.report || null)", -1, None, None, None, done, None
            )
            return True

        GLib.timeout_add(500, poll)
        GLib.timeout_add_seconds(TIMEOUT_S, lambda: app.quit())

    app.connect("activate", on_activate)
    app.run([])
    print(result["report"])


main()
