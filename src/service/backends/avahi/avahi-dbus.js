// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

const xmlDef = `
<node>
  <interface name="org.freedesktop.Avahi.Server2">

    <method name="GetVersionString">
      <arg name="version" type="s" direction="out"/>
    </method>

    <method name="GetAPIVersion">
      <arg name="version" type="u" direction="out"/>
    </method>

    <method name="GetHostName">
      <arg name="name" type="s" direction="out"/>
    </method>
    <method name="SetHostName">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="GetHostNameFqdn">
      <arg name="name" type="s" direction="out"/>
    </method>
    <method name="GetDomainName">
      <arg name="name" type="s" direction="out"/>
    </method>

    <method name="IsNSSSupportAvailable">
      <arg name="yes" type="b" direction="out"/>
    </method>

    <method name="GetState">
      <arg name="state" type="i" direction="out"/>
    </method>

    <signal name="StateChanged">
      <arg name="state" type="i"/>
      <arg name="error" type="s"/>
    </signal>

    <method name="GetLocalServiceCookie">
      <arg name="cookie" type="u" direction="out"/>
    </method>

    <method name="GetAlternativeHostName">
      <arg name="name" type="s" direction="in"/>
      <arg name="name" type="s" direction="out"/>
    </method>

    <method name="GetAlternativeServiceName">
      <arg name="name" type="s" direction="in"/>
      <arg name="name" type="s" direction="out"/>
    </method>

    <method name="GetNetworkInterfaceNameByIndex">
      <arg name="index" type="i" direction="in"/>
      <arg name="name" type="s" direction="out"/>
    </method>
    <method name="GetNetworkInterfaceIndexByName">
      <arg name="name" type="s" direction="in"/>
      <arg name="index" type="i" direction="out"/>
    </method>

    <method name="ResolveHostName">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="aprotocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="interface" type="i" direction="out"/>
      <arg name="protocol" type="i" direction="out"/>
      <arg name="name" type="s" direction="out"/>
      <arg name="aprotocol" type="i" direction="out"/>
      <arg name="address" type="s" direction="out"/>
      <arg name="flags" type="u" direction="out"/>
    </method>

    <method name="ResolveAddress">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="address" type="s" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="interface" type="i" direction="out"/>
      <arg name="protocol" type="i" direction="out"/>
      <arg name="aprotocol" type="i" direction="out"/>
      <arg name="address" type="s" direction="out"/>
      <arg name="name" type="s" direction="out"/>
      <arg name="flags" type="u" direction="out"/>
    </method>

    <method name="ResolveService">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="aprotocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="interface" type="i" direction="out"/>
      <arg name="protocol" type="i" direction="out"/>
      <arg name="name" type="s" direction="out"/>
      <arg name="type" type="s" direction="out"/>
      <arg name="domain" type="s" direction="out"/>
      <arg name="host" type="s" direction="out"/>
      <arg name="aprotocol" type="i" direction="out"/>
      <arg name="address" type="s" direction="out"/>
      <arg name="port" type="q" direction="out"/>
      <arg name="txt" type="aay" direction="out"/>
      <arg name="flags" type="u" direction="out"/>
    </method>

    <method name="EntryGroupNew">
      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="DomainBrowserPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="btype" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="ServiceTypeBrowserPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="ServiceBrowserPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="ServiceResolverPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="aprotocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="HostNameResolverPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="aprotocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="AddressResolverPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="address" type="s" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

    <method name="RecordBrowserPrepare">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="clazz" type="q" direction="in"/>
      <arg name="type" type="q" direction="in"/>
      <arg name="flags" type="u" direction="in"/>

      <arg name="path" type="o" direction="out"/>
    </method>

  </interface>
</node>
`;

const xmlEntry = `
<node>
  <interface name="org.freedesktop.Avahi.EntryGroup">
    <method name="Free"/>
    <method name="Commit"/>
    <method name="Reset"/>

    <method name="GetState">
      <arg name="state" type="i" direction="out"/>
    </method>

    <signal name="StateChanged">
      <arg name="state" type="i"/>
      <arg name="error" type="s"/>
    </signal>

    <method name="IsEmpty">
      <arg name="empty" type="b" direction="out"/>
    </method>

    <method name="AddService">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="host" type="s" direction="in"/>
      <arg name="port" type="q" direction="in"/>
      <arg name="txt" type="aay" direction="in"/>
    </method>

    <method name="AddServiceSubtype">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="subtype" type="s" direction="in"/>
    </method>

    <method name="UpdateServiceTxt">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="type" type="s" direction="in"/>
      <arg name="domain" type="s" direction="in"/>
      <arg name="txt" type="aay" direction="in"/>
    </method>

    <method name="AddAddress">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="address" type="s" direction="in"/>
    </method>

    <method name="AddRecord">
      <arg name="interface" type="i" direction="in"/>
      <arg name="protocol" type="i" direction="in"/>
      <arg name="flags" type="u" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="clazz" type="q" direction="in"/>
      <arg name="type" type="q" direction="in"/>
      <arg name="ttl" type="u" direction="in"/>
      <arg name="rdata" type="ay" direction="in"/>
    </method>
  </interface>
</node>
`;

const xmlServiceBrowser = `
<node>
  <interface name="org.freedesktop.Avahi.ServiceBrowser">

    <method name="Free"/>

    <method name="Start"/>

    <signal name="ItemNew">
      <arg name="interface" type="i"/>
      <arg name="protocol" type="i"/>
      <arg name="name" type="s"/>
      <arg name="type" type="s"/>
      <arg name="domain" type="s"/>
      <arg name="flags" type="u"/>
    </signal>

    <signal name="ItemRemove">
      <arg name="interface" type="i"/>
      <arg name="protocol" type="i"/>
      <arg name="name" type="s"/>
      <arg name="type" type="s"/>
      <arg name="domain" type="s"/>
      <arg name="flags" type="u"/>
    </signal>

    <signal name="Failure">
      <arg name="error" type="s"/>
    </signal>

    <signal name="AllForNow"/>

    <signal name="CacheExhausted"/>

  </interface>
</node>
`;

const xmlServiceResolve = `
<node>
  <interface name="org.freedesktop.Avahi.ServiceResolver">

    <method name="Free"/>

    <method name="Start"/>

    <signal name="Found">
      <arg name="interface" type="i" direction="out"/>
      <arg name="protocol" type="i" direction="out"/>
      <arg name="name" type="s" direction="out"/>
      <arg name="type" type="s" direction="out"/>
      <arg name="domain" type="s" direction="out"/>
      <arg name="host" type="s" direction="out"/>
      <arg name="aprotocol" type="i" direction="out"/>
      <arg name="address" type="s" direction="out"/>
      <arg name="port" type="q" direction="out"/>
      <arg name="txt" type="aay" direction="out"/>
      <arg name="flags" type="u" direction="out"/>
    </signal>

    <signal name="Failure">
      <arg name="error" type="s"/>
    </signal>

  </interface>
</node>
`;

const AvahiServer = Gio.DBusProxy.makeProxyWrapper(xmlDef);
const AvahiGroup = Gio.DBusProxy.makeProxyWrapper(xmlEntry);
const AvahiServiceBrowser = Gio.DBusProxy.makeProxyWrapper(xmlServiceBrowser);
const AvahiServiceResolve = Gio.DBusProxy.makeProxyWrapper(xmlServiceResolve);

export {AvahiServer, AvahiGroup, AvahiServiceBrowser, AvahiServiceResolve};
