# Reporting a bug

The main tool is **Advanced: debug info** in the settings modal. Tick the parts you want (your settings, button match status, browser and screen, session totals and recent activity), press **Build preview**, then edit the text to remove anything private before you copy. It copies a short plain-text snapshot you can paste into a bug report, no developer tools needed. Nothing leaves your device until you paste it somewhere.

The settings it reports come straight from the option list, so every setting is always in it. There is no second list to fall out of date and quietly leave something out.

The last section carries two things. **Session totals** count how many replies came back fine, how many retries fired, how many messages it gave up on, and a breakdown of retries by reason since the page was loaded. Those answer the questions a bug report usually can't ("it retries too much" becomes "ninety retries, all of them for cut off"). Under that is the **activity timeline**, the last twenty things it did, kept whether or not console logging is on.

For watching what the extension does live, turn on **Show a live log on screen** under Advanced: on-screen log. A small panel appears in the corner and updates in real time as generations run and retries fire, which is useful on mobile where the browser console is out of reach. Drag it around by its title bar and resize it from the bottom corner. **Copy** in its header puts the whole log on the clipboard, since selecting text by hand on a phone is awkward, and **Clear** empties it so a long session doesn't bury what you are watching for. It is controlled entirely by that toggle, so turn the toggle off to make it disappear.

---

[Back to the README](../README.md)
