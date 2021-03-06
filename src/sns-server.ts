import { SNS } from "aws-sdk";
import { Topic, TopicsList, Subscription, ListSubscriptionsResponse, CreateTopicResponse } from "aws-sdk/clients/sns.d";
import fetch from "node-fetch";
import { IDebug, ISNSServer } from "./types";
import bodyParser = require("body-parser");
import { v4 as uuid } from "uuid";
import * as xml from "xml";
const createAttr = () => {
    return {
        _attr: {
            xmlns: "http://sns.amazonaws.com/doc/2010-03-31/",
        },
    };
};

const createMetadata = () => {
    return {
        ResponseMetadata: [{
            RequestId: uuid(),
        }],
    };
};

const arrayify = obj => {
    return Object.keys(obj).map(key => {
        const x = {};
        x[key] = obj[key];
        return x;
    });
};

const parseMessageAttributes = body => {
    if (body.MessageStructure === "json") {
        return {};
    }

    const entries = Object.keys(body)
        .filter(key => key.startsWith("MessageAttributes.entry"))
        .reduce(
            (prev, key) => {
                const index = key.replace("MessageAttributes.entry.", "").match(/.*?(?=\.|$)/i)[0];
                return prev.includes(index) ? prev : [...prev, index];
            },
            [],
        );
    return entries
        .map(index => `MessageAttributes.entry.${index}`)
        .reduce(
            (prev, baseKey) => ({
                ...prev,
                [`${body[`${baseKey}.Name`]}`]: {
                    Type: body[`${baseKey}.Value.DataType`],
                    Value: body[`${baseKey}.Value.BinaryValue`] || body[`${baseKey}.Value.StringValue`],
                },
            }),
            {},
        );
};

export class SNSServer implements ISNSServer {
    private topics: TopicsList;
    private subscriptions: Subscription[];
    private pluginDebug: IDebug;
    private port: number;
    private server: any;
    private app: any;
    private region: string;
    private accountId: string;

    constructor(debug, app, region, accountId) {
        this.pluginDebug = debug;
        this.topics = [];
        this.subscriptions = [];
        this.app = app;
        this.region = region;
        this.routes();
        this.accountId = accountId;
    }

    public routes() {
        this.debug("configuring route");
        this.app.use(bodyParser.json()); // for parsing application/json
        this.app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
        this.app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
            next();
        });
        this.app.all("/", (req, res) => {
            this.debug("hello request");
            this.debug(JSON.stringify(req.body));
            this.debug(JSON.stringify(this.subscriptions));
            if (req.body.Action === "ListSubscriptions") {
                this.debug("sending: " + xml(this.listSubscriptions(), { indent: "\t" }));
                res.send(xml(this.listSubscriptions()));
            } else if (req.body.Action === "CreateTopic") {
                res.send(xml(this.createTopic(req.body.Name)));
            } else if (req.body.Action === "Subscribe") {
                res.send(xml(this.subscribe(req.body.Endpoint, req.body.Protocol, req.body.TopicArn)));
            } else if (req.body.Action === "Publish") {
                res.send(
                    xml(
                        this.publish(
                            req.body.TopicArn,
                            req.body.subject,
                            req.body.Message,
                            req.body.MessageStructure,
                            parseMessageAttributes(req.body),
                        ),
                    ),
                );
            } else if (req.body.Action === "Unsubscribe") {
                res.send(xml(this.unsubscribe(req.body.SubscriptionArn)));
            } else {
                res.send(xml({
                    NotImplementedResponse: [
                        createAttr(),
                        createMetadata(),
                    ],
                }));
            }
            this.debug(JSON.stringify(this.subscriptions));
        });
    }

    public listSubscriptions() {
        this.debug(this.subscriptions.map(sub => {
            return {
                member: [sub],
            };
        }));
        return {
            ListSubscriptionsResponse: [
                createAttr(),
                createMetadata(),
                {
                    ListSubscriptionsResult: [{
                        Subscriptions: this.subscriptions.map(sub => {
                            return {
                                member: arrayify({
                                    Endpoint: sub.Endpoint,
                                    TopicArn: sub.TopicArn,
                                    Owner: sub.Owner,
                                    Protocol: sub.Protocol,
                                    SubscriptionArn: sub.SubscriptionArn,
                                }),
                            };
                        }),
                    }],
                },
            ],
        };
    }

    public unsubscribe(arn) {
        this.debug(JSON.stringify(this.subscriptions));
        this.debug("unsubscribing: " + arn);
        this.subscriptions = this.subscriptions.filter(sub => sub.SubscriptionArn !== arn);
        return {
            UnsubscribeResponse: [
                createAttr(),
                createMetadata(),
            ],
        };
    }

    public createTopic(topicName) {
        const topic = {
            TopicArn: `arn:aws:sns:${this.region}:${this.accountId}:${topicName}`,
        };
        this.topics.push(topic);
        return {
            CreateTopicResponse: [
                createAttr(),
                createMetadata(),
                {
                    CreateTopicResult: [
                        {
                            TopicArn: topic.TopicArn,
                        },
                    ],
                },
            ],
        };
    }

    public subscribe(endpoint, protocol, arn) {
        arn = this.convertPsuedoParams(arn);
        const sub = {
            SubscriptionArn: arn + ":" + Math.floor(Math.random() * (1000000 - 1)),
            Protocol: protocol,
            TopicArn: arn,
            Endpoint: endpoint,
            Owner: "",
        };
        this.subscriptions.push(sub);
        return {
            SubscribeResponse: [
                createAttr(),
                createMetadata(),
                {
                    SubscribeResult: [
                        {
                            SubscriptionArn: sub.SubscriptionArn,
                        },
                    ],
                },
            ],
        };
    }

    public createEvent(topicArn, subscriptionArn, subject, message, messageAttributes?) {
        return {
            Records: [
                {
                    EventVersion: "1.0",
                    EventSubscriptionArn: subscriptionArn,
                    EventSource: "aws:sns",
                    Sns: {
                        SignatureVersion: "1",
                        Timestamp: new Date().toISOString(),
                        Signature: "EXAMPLE",
                        SigningCertUrl: "EXAMPLE",
                        MessageId: uuid(),
                        Message: message,
                        MessageAttributes: messageAttributes || {},
                        Type: "Notification",
                        UnsubscribeUrl: "EXAMPLE",
                        TopicArn: topicArn,
                        Subject: subject,
                    },
                },
            ],
        };
    }

    public publish(topicArn, subject, message, messageType, messageAttributes) {
        topicArn = this.convertPsuedoParams(topicArn);
        Promise.all(this.subscriptions.filter(sub => sub.TopicArn === topicArn).map(sub => {
            this.debug("fetching: " + sub.Endpoint);
            const event = JSON.stringify(this.createEvent(topicArn, sub.SubscriptionArn, subject, message, messageAttributes));
            this.debug("event: " + event);
            return fetch(sub.Endpoint, {
                method: "POST",
                body: event,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(event),
                },
            }).then(res => this.debug(res));
        }));
        return {
            PublishResponse: [
                createAttr(),
                createMetadata(),
            ],
        };
    }

    public convertPsuedoParams(topicArn) {
        const awsRegex = /#{AWS::([a-zA-Z]+)}/g;
        return topicArn.replace(awsRegex, this.accountId);
    }

    public debug(msg) {
        this.pluginDebug(msg, "server");
    }
}
