#!/bin/sh
# Refuse every new outbound connection except to the deployment's own internal network,
# then relay 7780 to Lookout as nobody (the switch drops every capability, so the firewall
# can no longer be changed). Replies to the Tester's connections are "established" and pass.
set -eu
for tables in iptables ip6tables; do
  $tables -P OUTPUT DROP
  $tables -A OUTPUT -o lo -j ACCEPT
  $tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
iptables -A OUTPUT -d "$INNER_SUBNET" -j ACCEPT
exec su-exec nobody socat TCP-LISTEN:7780,fork,reuseaddr "TCP:$TARGET"
