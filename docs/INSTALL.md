# NDA Tracker — Windows Installation Guide

This guide applies to the **v0.2.0-beta.1 Windows x64 preview**.

## Install and open

1. Download `NDA-Tracker-Setup-0.2.0-beta.1-x64.exe` from the [GitHub release](https://github.com/shiebin-bit/nda-tracking-dashboard/releases/tag/v0.2.0-beta.1).
2. Run the installer, choose an installation folder and finish setup.
3. Open **NDA Tracker** from the desktop shortcut or Start menu.

The installer includes the application runtime, SQLite database support and PDF converter. You do not need to install Docker, Node.js, a database server or Microsoft Office separately.

Each Windows user starts with an independent, empty workspace. Default NDA and EOI templates are included. Users' records are not shared automatically.

## Set up email reminders

1. Obtain your own Brevo API key and verify your sender address in Brevo.
2. Open **Settings → Desktop workspace** and save your API key and verified sender address.
3. Save the recipient, optional CC addresses, reminder milestones and daily check time in Malaysia time.
4. Send a test email when ready, then enable automatic reminders.

New workspaces start with reminders disabled and no email credentials. Changing the email connection pauses reminders; review the settings before enabling them again.

## Keep reminders running

Closing the window leaves NDA Tracker running in the system tray. Reminder checks require the computer to be awake and the application to remain running. Sending email requires an internet connection.

Enable **Start with Windows** to start the application after signing in. Choose **Quit NDA Tracker** from the tray to stop it completely.

## Back up and update

Use **Settings → Desktop workspace → Save complete backup** to save your records, templates and contract files. Save a complete backup before updating. Installing an update preserves your personal data folder.

Personal data is stored at `%LOCALAPPDATA%\NDA Tracker`. Do not copy the live database file while the application is running; use the complete-backup button instead. The Brevo API key is protected for the current Windows user and is excluded from database backups.

## Preview limitations and existing data

This is an unsigned Windows x64 preview. Company computers may require IT approval. A clean Windows virtual machine and company application-control policies have not yet been verified. Review generated contracts before sending them for signature.

Existing Docker/PostgreSQL data is not automatically imported or changed by this installer. It requires a separate migration. Avoid enabling reminders in two copies containing the same records.

See the [full Windows installation and recovery guide](https://github.com/shiebin-bit/nda-tracking-dashboard/blob/main/docs/WINDOWS_DESKTOP.md) for more details.
