#!/usr/bin/env python3
"""
Garmin FIT file parser for Apnea/Freediving sessions.
Extracts ALL available data channels — not just HR and temperature.

Usage:
    python3 fit_parser.py Apnea.fit
    python3 fit_parser.py Apnea.fit --json   # output raw JSON
"""

import struct, sys, json, datetime
from collections import defaultdict

FIT_EPOCH = 631065600  # seconds between 1970-01-01 and 1990-01-01

# ── BASE TYPE TABLE ──────────────────────────────────────────────────────────
# Maps FIT base_type_id -> (name, size_bytes, struct_format)
BASE_TYPES = {
    0x00: ('enum',    1, 'B',  0xFF),
    0x01: ('sint8',   1, 'b',  0x7F),
    0x02: ('uint8',   1, 'B',  0xFF),
    0x83: ('sint16',  2, '<h', 0x7FFF),
    0x84: ('uint16',  2, '<H', 0xFFFF),
    0x85: ('sint32',  4, '<i', 0x7FFFFFFF),
    0x86: ('uint32',  4, '<I', 0xFFFFFFFF),
    0x07: ('string',  1, None, None),
    0x88: ('float32', 4, '<f', None),
    0x89: ('float64', 8, '<d', None),
    0x8B: ('uint16z', 2, '<H', 0x0000),
    0x8C: ('uint32z', 4, '<I', 0x00000000),
    0x8E: ('sint64',  8, '<q', 0x7FFFFFFFFFFFFFFF),
    0x8F: ('uint64',  8, '<Q', 0xFFFFFFFFFFFFFFFF),
}

# ── KNOWN FIELD NAMES ────────────────────────────────────────────────────────
# Covers standard FIT fields AND Garmin Descend/freediving proprietary fields
# Format: { global_msg_num: { field_num: (name, scale, offset) } }
FIELD_DEFS = {
    # ── file_id (msg 0) ──────────────────────────────────────────────────────
    0: {
        0: ('type', 1, 0),
        1: ('manufacturer', 1, 0),
        2: ('product', 1, 0),
        4: ('time_created', 1, FIT_EPOCH),
    },

    # ── record (msg 20) — the main 1Hz time series ───────────────────────────
    # This is where almost all sensor data lives.
    20: {
        2:   ('altitude',                0.2,     -500),   # m
        3:   ('heart_rate',              1,        0),      # bpm
        4:   ('cadence',                 1,        0),
        5:   ('distance',                0.01,     0),      # m
        6:   ('speed',                   0.001,    0),      # m/s
        7:   ('power',                   1,        0),      # W
        13:  ('temperature',             1,        0),      # °C
        29:  ('accumulated_power',       1,        0),
        32:  ('vertical_speed',          0.001,    0),      # m/s (freediving: descent/ascent)
        33:  ('calories',                1,        0),
        39:  ('vertical_oscillation',    0.1,      0),
        57:  ('saturated_hemoglobin_%',  0.1,      0),      # SpO2 %
        72:  ('enhanced_altitude',       0.2,     -500),    # m
        78:  ('enhanced_altitude_2',     0.2,     -500),    # m (pool floor ref on Descend)
        87:  ('absolute_pressure',       1,        0),      # Pa (depth sensor)
        88:  ('depth',                   0.001,    0),      # m (scuba/freediving depth)
        89:  ('next_stop_depth',         0.001,    0),      # m
        90:  ('next_stop_time',          1,        0),      # s
        91:  ('time_to_surface',         0.001,    0),      # s — apnea HOLD TIMER on Garmin Descend
        92:  ('ndl_time',                0.01,     0),      # s — surface interval / NDL
        93:  ('cns_load',                1,        0),      # %
        94:  ('n2_load',                 1,        0),      # %
        95:  ('respiration_rate',        0.01,     0),      # breaths/min
        98:  ('enh_respiration_rate',    0.001,    0),      # breaths/min
        114: ('ascent_rate',             1,        0),
        126: ('air_time_remaining',      1,        0),      # s
        # Garmin Descend proprietary (undocumented field numbers):
        127: ('vertical_speed_raw',      1,        0),      # mm/s raw pressure change rate
        135: ('hrv_rr_interval',         1,        0),      # HRV / RR interval
        136: ('heart_rate_ch2',          1,        0),      # secondary HR channel
        253: ('timestamp',               1,        FIT_EPOCH),  # Unix time
    },

    # ── session (msg 18) ─────────────────────────────────────────────────────
    18: {
        0:   ('event', 1, 0),
        1:   ('event_type', 1, 0),
        2:   ('start_time', 1, FIT_EPOCH),
        5:   ('sport', 1, 0),
        6:   ('sub_sport', 1, 0),
        7:   ('total_elapsed_time', 0.001, 0),   # s
        8:   ('total_timer_time', 0.001, 0),     # s
        9:   ('total_distance', 0.01, 0),        # m
        11:  ('total_calories', 1, 0),
        16:  ('avg_heart_rate', 1, 0),
        17:  ('max_heart_rate', 1, 0),
        110: ('name', 1, 0),
        168: ('total_descent', 0.001, 0),        # m
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── length (msg 19) — individual apnea dives ─────────────────────────────
    # On Garmin apnea mode, each breath-hold = one "length"
    19: {
        0:   ('event', 1, 0),
        1:   ('event_type', 1, 0),
        2:   ('start_time', 1, FIT_EPOCH),
        7:   ('total_elapsed_time', 0.001, 0),  # s — BREATH HOLD DURATION
        8:   ('total_timer_time', 0.001, 0),    # s
        11:  ('total_calories', 1, 0),
        15:  ('min_heart_rate', 1, 0),          # bpm during hold
        16:  ('max_heart_rate', 1, 0),          # bpm during hold
        113: ('min_depth', 0.001, 0),           # m
        114: ('max_depth', 0.001, 0),           # m
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── lap (msg 18 / local) ─────────────────────────────────────────────────
    26: {
        0:   ('event', 1, 0),
        2:   ('start_time', 1, FIT_EPOCH),
        7:   ('total_elapsed_time', 0.001, 0),
        16:  ('avg_heart_rate', 1, 0),
        17:  ('max_heart_rate', 1, 0),
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── event (msg 21) ───────────────────────────────────────────────────────
    21: {
        0:   ('event', 1, 0),
        1:   ('event_type', 1, 0),
        3:   ('data', 1, 0),
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── device_info (msg 23) ─────────────────────────────────────────────────
    23: {
        0:   ('device_index', 1, 0),
        2:   ('manufacturer', 1, 0),
        3:   ('serial_number', 1, 0),
        4:   ('product', 1, 0),
        5:   ('software_version', 0.01, 0),
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── dive_summary / apnea_summary (msg 104) ───────────────────────────────
    # Garmin proprietary — periodic depth/battery snapshots
    104: {
        0:   ('avg_depth', 0.001, 0),           # m (average pool depth measured)
        2:   ('battery_status', 1, 0),          # % remaining
        3:   ('surface_interval', 1, 0),
        4:   ('dive_number', 1, 0),
        253: ('timestamp', 1, FIT_EPOCH),
    },

    # ── dive_gas (msg 258) ────────────────────────────────────────────────────
    258: {
        0:   ('helium_content', 1, 0),
        1:   ('oxygen_content', 1, 0),
        2:   ('status', 1, 0),
        253: ('timestamp', 1, FIT_EPOCH),
    },
}

# ── PARSER ───────────────────────────────────────────────────────────────────
def parse_fit(path):
    data = open(path, 'rb').read()

    # Validate header
    assert data[8:12] == b'.FIT', "Not a valid FIT file"
    hdr_size  = data[0]
    data_size = struct.unpack_from('<I', data, 4)[0]
    end = hdr_size + data_size

    local_defs   = {}   # local_type -> definition dict
    all_messages = defaultdict(list)   # global_msg_num -> [msg_dict, ...]

    offset = hdr_size
    prev_char = None

    while offset < end - 1:
        if offset >= len(data):
            break

        hdr = data[offset]; offset += 1

        # Compressed timestamp record — simplify: treat as data with last local type
        if hdr & 0x80:
            local_type = (hdr >> 5) & 0x03
            if local_type not in local_defs:
                continue
            defn = local_defs[local_type]
            total_sz = sum(f[1] for f in defn['fields'])
            offset += total_sz
            continue

        is_def  = bool(hdr & 0x40)
        has_dev = bool(hdr & 0x20)
        local_type = hdr & 0x0F

        if is_def:
            offset += 1  # reserved
            little_endian = (data[offset] == 0); offset += 1
            global_num = struct.unpack_from('<H' if little_endian else '>H', data, offset)[0]; offset += 2
            num_fields = data[offset]; offset += 1

            fields = []
            for _ in range(num_fields):
                fnum  = data[offset]
                fsz   = data[offset+1]
                btype = data[offset+2]
                fields.append((fnum, fsz, btype))
                offset += 3

            dev_fields = []
            if has_dev and offset < end:
                ndev = data[offset]; offset += 1
                for _ in range(ndev):
                    df = (data[offset], data[offset+1], data[offset+2])
                    dev_fields.append(df); offset += 3

            local_defs[local_type] = {
                'global':    global_num,
                'fields':    fields,
                'dev_fields':dev_fields,
                'le':        little_endian,
            }

        else:
            if local_type not in local_defs:
                break
            defn  = local_defs[local_type]
            gnum  = defn['global']
            le    = defn['le']
            msg   = {}

            for (fnum, fsz, btype) in defn['fields']:
                if offset + fsz > len(data):
                    offset += fsz; continue

                raw_bytes = data[offset:offset+fsz]

                # Read raw integer/float value
                if btype in BASE_TYPES:
                    _, sz, fmt, invalid = BASE_TYPES[btype]
                    if fmt is None:  # string
                        s = raw_bytes.rstrip(b'\x00').decode('utf-8', errors='replace')
                        msg[fnum] = s
                    else:
                        # Override endianness for multi-byte types
                        if not le and fsz > 1:
                            be_fmt = fmt.replace('<','>').replace('=','>')
                            val = struct.unpack_from(be_fmt, raw_bytes)[0]
                        else:
                            val = struct.unpack_from(fmt, raw_bytes)[0]
                        # Skip "invalid" sentinel values
                        if invalid is not None and val == invalid:
                            pass
                        else:
                            import math
                            if isinstance(val, float) and math.isnan(val):
                                pass
                            else:
                                msg[fnum] = val
                else:
                    # Unknown base type — store raw bytes as int if small
                    if fsz == 1:   msg[fnum] = data[offset]
                    elif fsz == 2: msg[fnum] = struct.unpack_from('<H', raw_bytes)[0]
                    elif fsz == 4: msg[fnum] = struct.unpack_from('<I', raw_bytes)[0]

                offset += fsz

            # Developer fields (proprietary data)
            for (dfnum, dfsz, dev_idx) in defn.get('dev_fields', []):
                if offset + dfsz > len(data):
                    offset += dfsz; continue
                rb = data[offset:offset+dfsz]
                key = f"dev_{dev_idx}_{dfnum}"
                if dfsz == 1:   msg[key] = data[offset]
                elif dfsz == 2: msg[key] = struct.unpack_from('<H', rb)[0]
                elif dfsz == 4: msg[key] = struct.unpack_from('<f', rb)[0]
                offset += dfsz

            if msg:
                all_messages[gnum].append(msg)

    return dict(all_messages)


# ── DECODE / SCALE ───────────────────────────────────────────────────────────
def decode_messages(raw):
    """
    Apply scale + offset to all known fields.
    Returns decoded messages with human-readable field names.
    """
    decoded = {}
    for gnum, msgs in raw.items():
        field_map = FIELD_DEFS.get(gnum, {})
        decoded_msgs = []
        for msg in msgs:
            dec = {}
            for fnum, raw_val in msg.items():
                if isinstance(fnum, str):  # dev field key
                    dec[fnum] = raw_val
                    continue
                if fnum in field_map:
                    name, scale, offset_val = field_map[fnum]
                    if isinstance(raw_val, (int, float)):
                        scaled = raw_val * scale + offset_val
                        dec[name] = round(scaled, 6) if scale != 1 else raw_val
                    else:
                        dec[name] = raw_val
                else:
                    dec[f"field_{fnum}"] = raw_val
            decoded_msgs.append(dec)
        decoded[gnum] = decoded_msgs
    return decoded


# ── EXTRACT TIME SERIES ───────────────────────────────────────────────────────
def extract_timeseries(decoded):
    """
    Build time series dict from msg 20 (record) messages.
    Returns { channel_name: [values...] } + { 'timestamps': [...] }
    """
    records = decoded.get(20, [])
    if not records:
        return {}

    t0 = None
    channels = defaultdict(list)

    for r in records:
        ts = r.get('timestamp')
        if ts is None:
            continue
        if t0 is None:
            t0 = ts
        channels['timestamp_s'].append(round(ts - t0, 3))

        # All numeric fields
        for k, v in r.items():
            if k == 'timestamp':
                continue
            if isinstance(v, (int, float)):
                channels[k].append(v)
            else:
                channels[k].append(None)

    return dict(channels)


# ── DIVE SUMMARY ─────────────────────────────────────────────────────────────
def extract_dives(decoded):
    """Extract individual dive (apnea hold) records from msg 19 (length)."""
    dives = []
    t0 = None

    # Get session start time
    sessions = decoded.get(18, [])
    if sessions:
        st = sessions[0].get('start_time')
        if st:
            t0 = st

    for i, r in enumerate(decoded.get(19, [])):
        ts_end   = r.get('timestamp', 0)
        ts_start = r.get('start_time', ts_end)
        elapsed  = r.get('total_elapsed_time', 0)

        dive = {
            'n':          i + 1,
            'start_unix': ts_start,
            'end_unix':   ts_end,
            'elapsed_s':  round(elapsed, 3),
            'min_hr':     r.get('min_heart_rate'),
            'max_hr':     r.get('max_heart_rate'),
            'min_depth_m': r.get('min_depth'),
            'max_depth_m': r.get('max_depth'),
        }
        if t0:
            dive['start_rel_s'] = ts_start - t0
            dive['end_rel_s']   = ts_end   - t0

        dives.append(dive)

    return dives


# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    path = sys.argv[1] if len(argv := sys.argv) > 1 else 'Apnea.fit'
    raw     = parse_fit(path)
    decoded = decode_messages(raw)
    ts      = extract_timeseries(decoded)
    dives   = extract_dives(decoded)

    print(f"\n{'='*60}")
    print(f"FIT FILE: {path}")
    print(f"{'='*60}")

    # Session info
    sessions = decoded.get(18, [{}])
    sess = sessions[0]
    if 'timestamp' in sess:
        dt = datetime.datetime.fromtimestamp(sess['timestamp'])
        print(f"\nSession end : {dt.strftime('%Y-%m-%d %H:%M:%S')}")
    if 'start_time' in sess:
        dt = datetime.datetime.fromtimestamp(sess['start_time'])
        print(f"Session start: {dt.strftime('%Y-%m-%d %H:%M:%S')}")
    if 'total_elapsed_time' in sess:
        t = sess['total_elapsed_time']
        print(f"Duration    : {int(t//60)}:{int(t%60):02d}")

    print(f"\n{'─'*40}")
    print("MESSAGE COUNTS")
    print(f"{'─'*40}")
    for gnum in sorted(raw.keys()):
        print(f"  Msg {gnum:4d} : {len(raw[gnum]):5d} records")

    print(f"\n{'─'*40}")
    print("TIME SERIES CHANNELS (msg 20)")
    print(f"{'─'*40}")
    non_none = lambda lst: [v for v in lst if v is not None]
    for ch, vals in sorted(ts.items()):
        if ch == 'timestamp_s':
            continue
        nv = non_none(vals)
        if nv:
            print(f"  {ch:<35s} count={len(nv):5d}  "
                  f"min={min(nv):10.3f}  max={max(nv):10.3f}")

    print(f"\n{'─'*40}")
    print(f"INDIVIDUAL DIVES (msg 19) — {len(dives)} total")
    print(f"{'─'*40}")
    for d in dives:
        m, s = divmod(d['elapsed_s'], 60)
        hr_range = f"HR {d['min_hr']}–{d['max_hr']} bpm" if d['min_hr'] else ""
        dep = f"depth {d['min_depth_m']:.2f}–{d['max_depth_m']:.2f}m" if d.get('max_depth_m') else ""
        print(f"  Dive {d['n']:2d}: {int(m)}:{int(s):02d}  {hr_range}  {dep}")

    # Export JSON if requested
    if '--json' in sys.argv:
        out = {
            'timeseries': ts,
            'dives':      dives,
            'session':    sess,
            'msg_counts': {str(k): len(v) for k, v in raw.items()},
        }
        out_path = path.replace('.fit', '_parsed.json').replace('.FIT', '_parsed.json')
        with open(out_path, 'w') as f:
            json.dump(out, f, indent=2, default=str)
        print(f"\n✅  JSON written to: {out_path}")

    return decoded, ts, dives


if __name__ == '__main__':
    main()
