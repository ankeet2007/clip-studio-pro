#!/usr/bin/env python
"""Render a tweet as a card PNG. DATA-DRIVEN (no login/credentials, no account risk): the caller
passes the tweet fields it already has from the public search. The scout's "screenshot the
tweet" capability. Usage: render_tweet_card.py <data.json> <out.png>
data.json = {"name","handle","text","avatar","poster","likes","verified"}  (all optional)"""
import sys, json, io, urllib.request
from PIL import Image, ImageDraw, ImageFont

def get(url,t=12):
    return urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}),timeout=t).read()
def img(url):
    try: return Image.open(io.BytesIO(get(url))).convert("RGB") if url else None
    except Exception: return None
F="/system/fonts/Roboto-"
def font(w,s): return ImageFont.truetype(F+w+".ttf",s)
def wrap(dr,text,fnt,maxw):
    out=[]
    for para in (text or "").split("\n"):
        line=""
        for word in para.split(" "):
            t=(line+" "+word).strip()
            if dr.textlength(t,font=fnt)<=maxw: line=t
            else:
                if line: out.append(line)
                line=word
        out.append(line)
    return out or [""]

def render(d,outp):
    name=(d.get("name") or "")[:40]; handle=d.get("handle") or ""; text=d.get("text") or ""
    W=1080; PAD=44; BG=(21,32,43); FG=(255,255,255); GY=(139,152,165)
    d0=ImageDraw.Draw(Image.new("RGB",(4,4)))
    fN=font("Bold",40); fH=font("Regular",34); fT=font("Regular",40); fS=font("Regular",30)
    lines=wrap(d0,text,fT,W-2*PAD)
    post=img(d.get("poster")); ph=int((W-2*PAD)*post.height/post.width) if post else 0
    H=PAD+120+PAD//2+len(lines)*54+50+(ph+PAD if post else 0)+PAD
    im=Image.new("RGB",(W,H),BG); dr=ImageDraw.Draw(im); y=PAD
    av=img(d.get("avatar"))
    if av:
        av=av.resize((104,104)); m=Image.new("L",(104,104),0); ImageDraw.Draw(m).ellipse((0,0,104,104),fill=255)
        im.paste(av,(PAD,y),m)
    else: dr.ellipse((PAD,y,PAD+104,y+104),fill=(83,100,113))
    tx=PAD+124
    dr.text((tx,y+8),name or "X user",font=fN,fill=FG); nw=dr.textlength(name or "X user",font=fN)
    if d.get("verified"): dr.ellipse((tx+nw+12,y+14,tx+nw+46,y+48),fill=(29,155,240)); dr.text((tx+nw+20,y+12),"✓",font=font("Bold",28),fill=FG)
    dr.text((tx,y+60),handle,font=fH,fill=GY)
    dr.text((W-PAD-30,y+4),"X",font=font("Bold",56),fill=FG)
    y+=120+PAD//2
    for ln in lines: dr.text((PAD,y),ln,font=fT,fill=FG); y+=54
    y+=12
    lk=d.get("likes")
    if lk: dr.text((PAD,y),f"{int(lk):,} Likes",font=fS,fill=GY)
    y+=50
    if post:
        post=post.resize((W-2*PAD,int((W-2*PAD)*post.height/post.width)))
        im.paste(post,(PAD,y))
    im.save(outp); print("OK",outp,im.size)

if __name__=="__main__":
    render(json.load(open(sys.argv[1])), sys.argv[2])
