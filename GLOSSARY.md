# Lookout

Lookout is a self-hosted web app that shows the health of the single Linux server it runs on and the Docker containers on that server.

## Language

**Host**:
The single Linux server the dashboard is deployed on and monitors.
_Avoid_: Machine, box, node, server (when ambiguous)

**Host Metric**:
A live measurement of the Host's resources, such as memory usage or disk space.
_Avoid_: Stat, health data

**Container**:
A running or stopped instance created from an Image. Containers are what the dashboard lists and controls.
_Avoid_: Docker image (when meaning a running thing), app, service

**Image**:
The template a Container is created from, identified by repository and tag.
_Avoid_: Container (when meaning the template)

**Compose Project**:
A group of Containers started together from one Docker Compose file. The dashboard groups Containers by Compose Project.
_Avoid_: Stack, app, group

**Flagged Container**:
A Container that needs attention because it is unhealthy, restarting, or exited with a non-zero code.
_Avoid_: Broken, failed, down

**Hostile Container**:
A Container on the Host whose labels, name, environment or logs are written to attack Lookout or the person viewing it.
_Avoid_: Malicious app, bad container

**Container Action**:
An operation that changes a Container's state: start, stop, restart, or remove.
_Avoid_: Command, operation, control

**Project Website**:
The public static page that describes Lookout and how to install it. It is separate from the dashboard, which is never public.
_Avoid_: Site (when ambiguous), landing page, docs site

**Live Window**:
The short, in-memory span of recent Host Metric samples used for sparklines. It is lost when the dashboard restarts.
_Avoid_: History, retention

**Hosted Site**:
A website served from the Host that Lookout checks, found from a Container's Traefik or `lookout.url` labels or listed in `LOOKOUT_SITES`.
_Avoid_: Site, website, endpoint

**Flagged Hosted Site**:
A Hosted Site that needs attention because it is down or its TLS certificate is at red (expired, expiring soon, untrusted or for another hostname).
_Avoid_: Broken site, outage

**Widget**:
One section of a dashboard page, such as CPU or the Container list, that the reader can move, resize, pin or hide on the Grid. It is a way of arranging the screen; its place is kept in the browser.
_Avoid_: Panel, card (that is how a section looks), tile

**Grid**:
The 12 columns and rows every Widget snaps to, and the Widgets menu that shows or hides them. Each page has its own.
_Avoid_: Dashboard (the whole app), layout (on its own)
